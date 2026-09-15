import { Injectable, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
import { Browser, Page } from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { ProspectoDto } from '../scraper/dto/prospecto.dto';

puppeteer.use(StealthPlugin());

export interface EstadoWhatsApp {
  conectado: boolean;
  enviando: boolean;
  enviadosHoy: number;
  topeDiario: number;
  mensajeEstado: string;
  prospectoActual?: string;
  tiempoSiguienteSegundos?: number;
}

export interface RegistroContacto {
  telefono: string;
  nombre: string;
  fecha: string;
  mensaje: string;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private browser: Browser | null = null;
  private page: Page | null = null;

  private conectado = false;
  private enviando = false;
  private pausarSolicitado = false;
  private prospectoActual: string | undefined;
  private tiempoSiguienteSegundos = 0;
  private mensajeEstado = 'WhatsApp desconectado. Haz clic en "Conectar WhatsApp".';

  private readonly topeDiario = 60;
  private readonly sessionPath = path.join(process.cwd(), '.wweb-session');
  private readonly dataDir = path.join(process.cwd(), 'data');
  private readonly uploadsDir = path.join(process.cwd(), 'uploads');
  private readonly historialPath = path.join(process.cwd(), 'data', 'contactados.json');
  private opcionesCampana?: {
    plantillas?: string[];
    mensajePersonalizado?: string;
    archivoAdjuntoPath?: string;
  };

  constructor() {
    this.asegurarDirectorioData();
  }

  private async asegurarDirectorioData() {
    try {
      if (!existsSync(this.dataDir)) {
        await fs.mkdir(this.dataDir, { recursive: true });
      }
      if (!existsSync(this.uploadsDir)) {
        await fs.mkdir(this.uploadsDir, { recursive: true });
      }
      if (!existsSync(this.historialPath)) {
        await fs.writeFile(this.historialPath, JSON.stringify([], null, 2), 'utf-8');
      }
    } catch (error) {
      this.logger.error(`Error al preparar directorio de datos: ${(error as Error).message}`);
    }
  }

  /**
   * Obtiene el estado actual de la conexión y de la campaña.
   */
  async obtenerEstado(): Promise<EstadoWhatsApp> {
    const enviadosHoy = await this.contarEnviadosHoy();
    return {
      conectado: this.conectado,
      enviando: this.enviando,
      enviadosHoy,
      topeDiario: this.topeDiario,
      mensajeEstado: this.mensajeEstado,
      prospectoActual: this.prospectoActual,
      tiempoSiguienteSegundos: this.tiempoSiguienteSegundos,
    };
  }

  /**
   * Abre una ventana visible de Chromium para iniciar sesión en WhatsApp Web
   * o restaura la sesión existente memorizada en .wweb-session.
   */
  async conectar(): Promise<{ exito: boolean; mensaje: string }> {
    if (this.conectado && this.browser) {
      return { exito: true, mensaje: 'WhatsApp Web ya se encuentra conectado.' };
    }

    this.mensajeEstado = 'Abriendo WhatsApp Web... Escanea el código QR en la ventana que aparece.';
    this.logger.log('Iniciando sesión de WhatsApp Web con perfil persistente...');

    try {
      if (this.browser) {
        try {
          await this.browser.close();
        } catch {}
      }

      this.browser = await puppeteer.launch({
        headless: false, // Visible para que el usuario escanee el QR fácilmente
        userDataDir: this.sessionPath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--window-size=1024,768',
        ],
      });

      const pages = await this.browser.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
      await this.page.setViewport({ width: 1024, height: 768 });

      await this.page.goto('https://web.whatsapp.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Esperar a que el usuario inicie sesión (aparece el panel lateral de chats)
      this.logger.log('Esperando autenticación en WhatsApp Web...');
      this.esperarAutenticacionEnSegundoPlano();

      return {
        exito: true,
        mensaje: 'Ventana de WhatsApp Web abierta. Escanea el código QR si aún no has iniciado sesión.',
      };
    } catch (error) {
      this.mensajeEstado = `Error al conectar: ${(error as Error).message}`;
      this.logger.error(this.mensajeEstado);
      return { exito: false, mensaje: this.mensajeEstado };
    }
  }

  /**
   * Monitorea si el usuario ya inició sesión con éxito.
   */
  private async esperarAutenticacionEnSegundoPlano() {
    if (!this.page) return;

    try {
      // El panel de chats (#pane-side o div[role="textbox"]) indica sesión iniciada
      await this.page.waitForSelector('#pane-side, div[role="textbox"], [data-icon="chat"]', {
        timeout: 180000, // 3 minutos para escanear
      });

      this.conectado = true;
      this.mensajeEstado = 'WhatsApp Web conectado exitosamente. Listo para enviar.';
      this.logger.log('¡WhatsApp Web autenticado correctamente!');
    } catch (err) {
      if (!this.conectado) {
        this.mensajeEstado = 'Tiempo de espera para escanear QR agotado o ventana cerrada.';
        this.logger.warn(this.mensajeEstado);
      }
    }
  }

  /**
   * Inicia la campaña de envíos automatizados con tope diario de 60 y pausas aleatorias.
   */
  async iniciarCampana(
    prospectos: ProspectoDto[],
    opciones?: {
      plantillas?: string[];
      mensajePersonalizado?: string;
      archivoAdjuntoPath?: string;
    },
  ): Promise<{ exito: boolean; mensaje: string }> {
    if (!this.conectado || !this.page) {
      return {
        exito: false,
        mensaje: 'Primero debes conectar WhatsApp Web y escanear el código QR.',
      };
    }

    if (this.enviando) {
      return { exito: false, mensaje: 'Ya hay una campaña de envíos en ejecución.' };
    }

    const enviadosHoy = await this.contarEnviadosHoy();
    if (enviadosHoy >= this.topeDiario) {
      return {
        exito: false,
        mensaje: `Ya alcanzaste el tope seguro de ${this.topeDiario} mensajes para hoy. Continúa mañana para proteger tu número.`,
      };
    }

    // Guardar opciones de la campaña activa
    this.opcionesCampana = opciones;

    // Filtrar solo prospectos con número celular y no contactados previamente
    const historial = await this.obtenerHistorial();
    const telefonosContactados = new Set(historial.map((h) => h.telefono));

    const candidatos = prospectos.filter((p) => {
      if (!p.telefono || !p.whatsappUrl) return false;
      const numLimpio = p.telefono.replace(/[^\d]/g, '');
      return !telefonosContactados.has(numLimpio);
    });

    if (candidatos.length === 0) {
      return {
        exito: false,
        mensaje: 'No hay prospectos nuevos pendientes para enviar (o todos ya fueron contactados).',
      };
    }

    this.enviando = true;
    this.pausarSolicitado = false;
    this.ejecutarColaEnvios(candidatos);

    return {
      exito: true,
      mensaje: `Campaña iniciada para ${candidatos.length} prospectos con pausas humanas de 20s a 45s.`,
    };
  }

  /**
   * Bucle asíncrono que procesa la cola con intervalos aleatorios.
   */
  private async ejecutarColaEnvios(candidatos: ProspectoDto[]) {
    let index = 0;

    for (const prospecto of candidatos) {
      if (this.pausarSolicitado) {
        this.mensajeEstado = 'Campaña pausada por el usuario.';
        this.logger.log('Campaña pausada por solicitud del usuario.');
        break;
      }

      const totalHoy = await this.contarEnviadosHoy();
      if (totalHoy >= this.topeDiario) {
        this.mensajeEstado = `Tope diario de ${this.topeDiario} envíos alcanzado. Pausando automáticamente por seguridad.`;
        this.logger.log(this.mensajeEstado);
        break;
      }

      index++;
      this.prospectoActual = prospecto.nombre;
      this.mensajeEstado = `[${index}/${candidatos.length}] Procesando envío a: "${prospecto.nombre}"...`;
      this.logger.log(this.mensajeEstado);

      try {
        const enviado = await this.enviarMensajeProspecto(prospecto);

        if (enviado) {
          const hoyCount = await this.contarEnviadosHoy();
          this.logger.log(
            `Mensaje enviado a "${prospecto.nombre}" (${prospecto.telefono}) - Total hoy: ${hoyCount}/${this.topeDiario}`,
          );
        }

        // Si quedan prospectos por enviar, aplicar la pausa humana aleatoria (20s a 45s)
        if (index < candidatos.length && !this.pausarSolicitado) {
          const segundosPausa = Math.floor(20 + Math.random() * 25); // 20 a 45 segundos
          this.tiempoSiguienteSegundos = segundosPausa;

          for (let s = segundosPausa; s > 0; s--) {
            if (this.pausarSolicitado) break;
            this.tiempoSiguienteSegundos = s;
            this.mensajeEstado = `Pausa humana de seguridad: Siguiente envío en ${s}s (Protegiendo tu cuenta)...`;
            await new Promise((r) => setTimeout(r, 1000));
          }
          this.tiempoSiguienteSegundos = 0;
        }
      } catch (err) {
        this.logger.warn(
          `Error al enviar mensaje a "${prospecto.nombre}": ${(err as Error).message}`,
        );
      }
    }

    this.enviando = false;
    this.prospectoActual = undefined;
    this.tiempoSiguienteSegundos = 0;
    if (!this.pausarSolicitado) {
      this.mensajeEstado = 'Campaña finalizada exitosamente.';
    }
  }

  /**
   * Envía un mensaje individual en WhatsApp Web navegando al chat directo.
   */
  private async enviarMensajeProspecto(prospecto: ProspectoDto): Promise<boolean> {
    if (!this.page || !prospecto.telefono) return false;

    // Normalizar número telefónico internacional para Ecuador (5939...)
    const numLimpio = prospecto.telefono.replace(/[^\d]/g, '');
    const telefonoEcuador = numLimpio.startsWith('593')
      ? numLimpio
      : numLimpio.startsWith('0')
        ? `593${numLimpio.slice(1)}`
        : `593${numLimpio}`;

    // 1. Obtener la plantilla a usar: si hay lista de plantillas, rotar aleatoriamente
    let plantillaSeleccionada = '';
    const plantillasValidas = (this.opcionesCampana?.plantillas || []).filter(
      (p) => p && p.trim().length > 0,
    );

    if (plantillasValidas.length > 0) {
      const indice = Math.floor(Math.random() * plantillasValidas.length);
      plantillaSeleccionada = plantillasValidas[indice];
    } else if (
      this.opcionesCampana?.mensajePersonalizado &&
      this.opcionesCampana.mensajePersonalizado.trim().length > 0
    ) {
      plantillaSeleccionada = this.opcionesCampana.mensajePersonalizado;
    }

    // 2. Reemplazar variables dinámicas {nombre}, {sector}, {categoria}
    let mensaje = '';
    if (plantillaSeleccionada) {
      const nombreLimpio = this.formatearNombreComercio(prospecto.nombre);
      const sector = this.extraerSector(prospecto.direccion);
      const categoria = prospecto.categoria || 'Comercio';

      mensaje = plantillaSeleccionada
        .replace(/\{nombre\}/gi, nombreLimpio)
        .replace(/\{sector\}/gi, sector)
        .replace(/\{categoria\}/gi, categoria);
    } else {
      mensaje = this.generarMensajeGancho(prospecto);
    }

    // 1. Navegar directamente a la URL de WhatsApp Web con el texto pre-cargado
    const sendUrl = `https://web.whatsapp.com/send?phone=${telefonoEcuador}&text=${encodeURIComponent(mensaje)}`;
    await this.page.goto(sendUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
    });

    // Esperar a que cargue la caja de texto editable o el diálogo de error
    try {
      const chatInputSelector =
        'div[contenteditable="true"][data-tab="10"], footer div[contenteditable="true"], div[role="textbox"]';
      await this.page.waitForSelector(chatInputSelector, { timeout: 25000 });

      // Pausa humana breve de 1.5s a 2.5s antes de presionar enviar
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));

      // Presionar Enter para enviar el texto
      await this.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 2000));

      // 2. Si el usuario configuró un archivo adjunto (PDF / Imagen), adjuntarlo en el mismo chat
      const archivoPath = this.opcionesCampana?.archivoAdjuntoPath;
      if (archivoPath && existsSync(archivoPath)) {
        try {
          this.logger.log(
            `Adjuntando archivo "${path.basename(archivoPath)}" para ${prospecto.nombre}...`,
          );

          // Buscar el input de archivos o desplegar el menú de adjuntos
          let fileInput = await this.page.$('input[type="file"]');
          if (!fileInput) {
            const attachBtn = await this.page.$(
              'button[title*="Adjuntar"], span[data-icon="plus"], div[title*="Adjuntar"], span[data-icon="clip"], button[aria-label*="Adjuntar"]',
            );
            if (attachBtn) {
              await attachBtn.click();
              await new Promise((r) => setTimeout(r, 1000));
              fileInput = await this.page.$('input[type="file"]');
            }
          }

          if (fileInput) {
            await fileInput.uploadFile(archivoPath);

            // Esperar al botón de envío de la vista previa del medio
            const sendMediaBtnSelector =
              'span[data-icon="send"], div[aria-label*="Enviar"], button[aria-label*="Enviar"]';
            await this.page.waitForSelector(sendMediaBtnSelector, { timeout: 20000 });
            await new Promise((r) => setTimeout(r, 1500));

            const sendBtn = await this.page.$(sendMediaBtnSelector);
            if (sendBtn) {
              await sendBtn.click();
            } else {
              await this.page.keyboard.press('Enter');
            }
            await new Promise((r) => setTimeout(r, 3000));
            this.logger.log(
              `Archivo adjunto enviado exitosamente a "${prospecto.nombre}".`,
            );
          } else {
            this.logger.warn(
              'No se encontró el selector de adjuntos en WhatsApp Web.',
            );
          }
        } catch (adjuntoErr) {
          this.logger.warn(
            `No se pudo adjuntar el archivo a ${prospecto.nombre}: ${(adjuntoErr as Error).message}`,
          );
        }
      }

      // Registrar en historial para no repetir
      await this.guardarEnHistorial({
        telefono: numLimpio,
        nombre: prospecto.nombre,
        fecha: new Date().toISOString(),
        mensaje: archivoPath
          ? `${mensaje} [Adjunto: ${path.basename(archivoPath)}]`
          : mensaje,
      });

      return true;
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar mensaje a ${prospecto.nombre} (${telefonoEcuador}): Posible número sin WhatsApp o error de carga.`,
      );
      return false;
    }
  }

  /**
   * Genera un mensaje gancho amable con Spintax y personalización de nombre y sector.
   * Sin enlaces sospechosos para inducir respuesta y evitar reportes de spam.
   */
  private generarMensajeGancho(prospecto: ProspectoDto): string {
    const nombreLimpio = this.formatearNombreComercio(prospecto.nombre);
    const sector = this.extraerSector(prospecto.direccion);

    const plantillas = [
      `Buenas tardes estimad@s de *${nombreLimpio}*, un gusto saludarles 👋. Vimos su negocio en ${sector}. ¿Disculpe este es el número directo para consultas?`,
      `Hola qué tal amigos de *${nombreLimpio}*, espero que todo marche excelente. Les escribo porque encontramos su local en ${sector}. ¿Este WhatsApp es del área de atención o administración?`,
      `Saludos cordiales a todo el equipo de *${nombreLimpio}* 👋. Qué gusto ver su local en ${sector}. ¿Por este número atienden consultas de clientes?`,
    ];

    // Selección aleatoria para que los mensajes no sean idénticos
    const indice = Math.floor(Math.random() * plantillas.length);
    return plantillas[indice];
  }

  private formatearNombreComercio(nombre: string): string {
    const limpio = nombre.replace(/["'”]/g, '').trim();
    if (limpio.length > 30) {
      return limpio.slice(0, 30);
    }
    return limpio;
  }

  private extraerSector(direccion?: string): string {
    if (!direccion) return 'su sector';
    const partes = direccion.split(',');
    if (partes.length > 1) {
      return partes[0].trim();
    }
    return direccion.slice(0, 25).trim();
  }

  /**
   * Pausa la campaña en ejecución.
   */
  pausarCampana(): { exito: boolean; mensaje: string } {
    if (!this.enviando) {
      return { exito: false, mensaje: 'No hay ninguna campaña activa en este momento.' };
    }
    this.pausarSolicitado = true;
    this.mensajeEstado = 'Pausando campaña...';
    return { exito: true, mensaje: 'Se solicitó pausar la campaña.' };
  }

  /**
   * Guarda un contacto en el archivo de historial JSON.
   */
  private async guardarEnHistorial(registro: RegistroContacto) {
    try {
      const historial = await this.obtenerHistorial();
      historial.push(registro);
      await fs.writeFile(this.historialPath, JSON.stringify(historial, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error(`Error al guardar en historial: ${(error as Error).message}`);
    }
  }

  /**
   * Obtiene la lista completa de contactos en el historial.
   */
  async obtenerHistorial(): Promise<RegistroContacto[]> {
    try {
      if (!existsSync(this.historialPath)) return [];
      const data = await fs.readFile(this.historialPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /**
   * Cuenta cuántos mensajes se han enviado en la fecha de hoy.
   */
  private async contarEnviadosHoy(): Promise<number> {
    const hoy = new Date().toISOString().slice(0, 10);
    const historial = await this.obtenerHistorial();
    return historial.filter((item) => item.fecha.startsWith(hoy)).length;
  }
}
