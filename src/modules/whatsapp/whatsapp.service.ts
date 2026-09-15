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
  qrCode?: string | null;
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
  private qrCode: string | null = null;
  private intervaloMonitoreo: NodeJS.Timeout | null = null;

  private readonly topeDiario = 60;
  private readonly sessionPath = path.join(process.cwd(), '.wweb-session');
  private readonly dataDir = path.join(process.cwd(), 'data');
  private readonly uploadsDir = path.join(process.cwd(), 'uploads');
  private readonly historialPath = path.join(process.cwd(), 'data', 'contactados.json');
  private opcionesCampana?: {
    plantillas?: string[];
    mensajePersonalizado?: string;
    archivoAdjuntoPath?: string;
    archivosAdjuntosPaths?: string[];
    tipoAdjunto?: 'foto' | 'documento';
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
   * Obtiene el estado actual de la conexión, QR y campaña.
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
      qrCode: this.qrCode,
    };
  }

  /**
   * Abre WhatsApp Web en Chrome visible y captura el código QR para el usuario.
   */
  async conectar(): Promise<{ exito: boolean; mensaje: string }> {
    if (this.conectado && this.browser) {
      return { exito: true, mensaje: 'WhatsApp Web ya se encuentra conectado.' };
    }

    this.mensajeEstado = 'Iniciando WhatsApp Web... Por favor espera un momento.';
    this.logger.log('Iniciando sesión de WhatsApp Web con perfil persistente...');

    try {
      if (this.intervaloMonitoreo) {
        clearInterval(this.intervaloMonitoreo);
        this.intervaloMonitoreo = null;
      }

      if (this.browser) {
        try {
          await this.browser.close();
        } catch {}
      }

      // Buscar Chrome del sistema para garantizar ventana visible en Windows
      let executablePath: string | undefined = undefined;
      const posiblesRutasChrome = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      ];
      for (const ruta of posiblesRutasChrome) {
        if (existsSync(ruta)) {
          executablePath = ruta;
          this.logger.log(`Usando ejecutable de Chrome detectado: ${ruta}`);
          break;
        }
      }

      this.browser = await puppeteer.launch({
        headless: false,
        executablePath,
        userDataDir: this.sessionPath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--start-maximized',
          '--window-size=1280,850',
          '--window-position=50,50',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      });

      const pages = await this.browser.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 850 });

      // Cargar WhatsApp Web
      await this.page.goto('https://web.whatsapp.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      this.logger.log('Página de WhatsApp Web cargada. Iniciando monitoreo de autenticación y QR...');
      this.iniciarMonitoreoAutenticacionYQr();

      return {
        exito: true,
        mensaje: 'WhatsApp Web abierto. Puedes escanear el código QR en la ventana o directamente aquí en pantalla.',
      };
    } catch (error) {
      this.mensajeEstado = `Error al conectar: ${(error as Error).message}`;
      this.logger.error(this.mensajeEstado);
      return { exito: false, mensaje: this.mensajeEstado };
    }
  }

  /**
   * Monitorea si ya se autenticó o captura el QR en base64 para mostrarlo en la interfaz web.
   */
  private iniciarMonitoreoAutenticacionYQr() {
    if (this.intervaloMonitoreo) {
      clearInterval(this.intervaloMonitoreo);
    }

    let intentos = 0;
    this.intervaloMonitoreo = setInterval(async () => {
      if (this.conectado || !this.page || this.page.isClosed()) {
        if (this.intervaloMonitoreo) clearInterval(this.intervaloMonitoreo);
        return;
      }

      intentos++;

      try {
        // 1. Verificar si el panel de chats ya cargó (sesión iniciada)
        const panelChats = await this.page.$('#pane-side, [data-icon="chat"], div[role="textbox"]');
        if (panelChats) {
          this.conectado = true;
          this.qrCode = null;
          this.mensajeEstado = 'WhatsApp Web conectado exitosamente. ¡Listo para enviar!';
          this.logger.log('¡WhatsApp Web autenticado correctamente!');
          if (this.intervaloMonitoreo) clearInterval(this.intervaloMonitoreo);
          return;
        }

        // 2. Si no está autenticado, intentar capturar el QR
        const canvas = await this.page.$('canvas');
        if (canvas) {
          const qrBase64 = await canvas.screenshot({ encoding: 'base64' });
          this.qrCode = `data:image/png;base64,${qrBase64}`;
          this.mensajeEstado = 'Código QR disponible. Escanéalo con tu celular en la pantalla o en Chrome.';
        } else {
          // Si el QR expiró, presionar el botón de recarga
          const reloadBtn = await this.page.$(
            'div[role="button"]:has(span[data-icon="refresh"]), span[data-icon="refresh"], button[aria-label*="recargar"]',
          );
          if (reloadBtn) {
            await reloadBtn.click();
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        // Si pasan 5 minutos sin escanear, detener
        if (intentos > 150) {
          this.mensajeEstado = 'Tiempo de espera para escanear QR agotado. Haz clic en Conectar nuevamente.';
          if (this.intervaloMonitoreo) clearInterval(this.intervaloMonitoreo);
        }
      } catch (err) {
        // Ignorar errores transitorios de navegación
      }
    }, 2000);
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
      archivosAdjuntosPaths?: string[];
      tipoAdjunto?: 'foto' | 'documento';
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

    // Normalizar archivos adjuntos
    let adjuntosFinales: string[] = [];
    if (opciones?.archivosAdjuntosPaths && Array.isArray(opciones.archivosAdjuntosPaths)) {
      adjuntosFinales = opciones.archivosAdjuntosPaths.filter((p) => existsSync(p));
    } else if (opciones?.archivoAdjuntoPath && existsSync(opciones.archivoAdjuntoPath)) {
      adjuntosFinales = [opciones.archivoAdjuntoPath];
    }

    this.opcionesCampana = {
      ...opciones,
      archivosAdjuntosPaths: adjuntosFinales,
    };

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

      const exitoEnvio = await this.enviarMensajeProspecto(prospecto);

      if (exitoEnvio) {
        const nuevosEnviados = await this.contarEnviadosHoy();
        this.logger.log(
          `[${nuevosEnviados}/${this.topeDiario}] Enviado exitosamente a: ${prospecto.nombre} (${prospecto.telefono})`,
        );
      }

      // Si aún quedan prospectos, esperar un tiempo aleatorio humano (20 a 45 seg)
      if (index < candidatos.length && !this.pausarSolicitado) {
        const esperaSegundos = Math.floor(20 + Math.random() * 25);
        this.tiempoSiguienteSegundos = esperaSegundos;

        for (let s = esperaSegundos; s > 0; s--) {
          if (this.pausarSolicitado) break;
          this.tiempoSiguienteSegundos = s;
          this.mensajeEstado = `Esperando ${s}s antes del siguiente contacto (Anti-Baneo humano)...`;
          await new Promise((r) => setTimeout(r, 1000));
        }
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
   * Envía un mensaje individual en WhatsApp Web y adjunta múltiples imágenes/archivos.
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
    const nombreLimpio = this.formatearNombreComercio(prospecto.nombre);
    const sector = this.extraerSector(prospecto.direccion);
    const categoria = prospecto.categoria || 'Comercio';

    if (plantillaSeleccionada) {
      mensaje = plantillaSeleccionada
        .replace(/\{nombre\}/gi, nombreLimpio)
        .replace(/\{sector\}/gi, sector)
        .replace(/\{categoria\}/gi, categoria);
    } else {
      mensaje = this.generarMensajeGancho(prospecto);
    }

    // Navegar directamente a la URL de WhatsApp Web con el texto pre-cargado
    const sendUrl = `https://web.whatsapp.com/send?phone=${telefonoEcuador}&text=${encodeURIComponent(mensaje)}`;
    await this.page.goto(sendUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
    });

    try {
      const chatInputSelector =
        'div[contenteditable="true"][data-tab="10"], footer div[contenteditable="true"], div[role="textbox"]';
      await this.page.waitForSelector(chatInputSelector, { timeout: 25000 });

      // Pausa humana breve de 1.5s a 2.5s antes de presionar enter
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));

      // Presionar Enter para enviar el texto
      await this.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 2000));

      // 3. Adjuntar múltiples imágenes / archivos si fueron configurados
      const archivos = this.opcionesCampana?.archivosAdjuntosPaths || [];
      const archivosValidos = archivos.filter((p) => existsSync(p));

      if (archivosValidos.length > 0) {
        try {
          const modoEnvio = this.opcionesCampana?.tipoAdjunto || 'foto';
          this.logger.log(
            `Adjuntando ${archivosValidos.length} archivo(s) para ${prospecto.nombre} (Modo: ${modoEnvio})...`,
          );

          // 1. Desplegar menú de adjuntos (+)
          const attachBtn = await this.page.$(
            'button[title*="Adjuntar"], span[data-icon="plus"], div[title*="Adjuntar"], span[data-icon="clip"], button[aria-label*="Adjuntar"]',
          );
          if (attachBtn) {
            await attachBtn.click();
            await new Promise((r) => setTimeout(r, 1000));
          }

          // 2. Obtener todos los inputs de archivo en la página
          const allInputs = await this.page.$$('input[type="file"]');
          let targetInput = null;

          const hayPdfs = archivosValidos.some(
            (p) => p.toLowerCase().endsWith('.pdf') || p.toLowerCase().endsWith('.docx'),
          );
          const enviarComoDocumento = hayPdfs || modoEnvio === 'documento';

          for (const inp of allInputs) {
            const accept = await inp.evaluate((el: HTMLInputElement) => el.accept || '');
            
            if (enviarComoDocumento) {
              // Input de documentos en WhatsApp Web (accept="*" o sin filtro)
              if (accept === '*' || accept === '' || accept.includes('application/')) {
                targetInput = inp;
                break;
              }
            } else {
              // Input de Fotos y Videos en WhatsApp Web:
              // WhatsApp Web usa: accept="image/*,video/mp4,video/3gpp,video/quicktime"
              // OJO: WhatsApp usa accept="image/png,image/jpeg,image/webp" para su STICKER MAKER.
              // Por tanto, descartamos estrictamente el que contenga "image/webp" sin "video"
              const esInputSticker = accept.includes('image/webp') && !accept.includes('video');
              if (accept.includes('image/*') && !esInputSticker) {
                targetInput = inp;
                break;
              }
            }
          }

          // Si no encontró el preferido, usar cualquiera que NO sea el creador de stickers
          if (!targetInput) {
            for (const inp of allInputs) {
              const accept = await inp.evaluate((el: HTMLInputElement) => el.accept || '');
              const esInputSticker = accept.includes('image/webp') && !accept.includes('video');
              if (!esInputSticker) {
                targetInput = inp;
                break;
              }
            }
          }

          if (targetInput) {
            // Subir archivos al input de adjuntos normal
            await targetInput.uploadFile(...archivosValidos);

            // Esperar al botón de envío de la vista previa de medios en WhatsApp Web
            const sendMediaBtnSelector =
              'span[data-icon="send"], div[aria-label*="Enviar"], button[aria-label*="Enviar"]';
            await this.page.waitForSelector(sendMediaBtnSelector, { timeout: 25000 });
            await new Promise((r) => setTimeout(r, 1500));

            const sendBtn = await this.page.$(sendMediaBtnSelector);
            if (sendBtn) {
              await sendBtn.click();
            } else {
              await this.page.keyboard.press('Enter');
            }
            await new Promise((r) => setTimeout(r, 3500));
            this.logger.log(
              `Archivos (${archivosValidos.length}) enviados exitosamente como adjunto regular a "${prospecto.nombre}".`,
            );
          } else {
            this.logger.warn('No se encontró el selector de adjuntos adecuado en WhatsApp Web.');
          }
        } catch (adjuntoErr) {
          this.logger.warn(
            `No se pudo adjuntar archivos a ${prospecto.nombre}: ${(adjuntoErr as Error).message}`,
          );
        }
      }

      // Registrar en historial para no repetir
      const resumenAdjuntos = archivosValidos.length > 0
        ? ` [${archivosValidos.length} adjuntos]`
        : '';
      await this.guardarEnHistorial({
        telefono: numLimpio,
        nombre: prospecto.nombre,
        fecha: new Date().toISOString(),
        mensaje: `${mensaje}${resumenAdjuntos}`,
      });

      return true;
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar mensaje a ${prospecto.nombre} (${telefonoEcuador}): Posible número sin WhatsApp o timeout de carga.`,
      );
      return false;
    }
  }

  /**
   * Genera mensaje gancho amable por defecto (CodeCima Facturación Electrónica).
   */
  private generarMensajeGancho(prospecto: ProspectoDto): string {
    const nombreLimpio = this.formatearNombreComercio(prospecto.nombre);

    const plantillas = [
      `Hola estimad@ *${nombreLimpio}*, un gusto saludarles 👋. Les escribimos de parte de CodeCima. Contamos con una solución de Facturación Electrónica para el SRI, pensada para micro y pequeños negocios. Pueden facturar fácilmente desde celular o computadora, sin procesos complicados. ¿Les gustaría conocerla en una demo rápida de 2 minutos?`,
      `Hola *${nombreLimpio}* 👋. En CodeCima estamos ayudando a negocios a simplificar su facturación electrónica y reducir el tiempo que dedican a emitir comprobantes. Nuestro sistema funciona desde cualquier dispositivo y está pensado para ser sencillo de utilizar. Si gustan, podemos mostrarles cómo funciona en una demo breve y sin compromiso. ¿Les interesa?`,
      `Hola *${nombreLimpio}*, esperamos que se encuentren muy bien 👋. Actualmente en CodeCima estamos incorporando negocios a nuestro programa piloto de facturación electrónica. La plataforma permite emitir y gestionar comprobantes electrónicos de manera rápida desde celular o computadora. Tenemos cupos disponibles para probar el sistema. ¿Les gustaría recibir más información?`,
    ];

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
      return partes[1].trim();
    }
    return partes[0].trim();
  }

  pausarCampana(): { exito: boolean; mensaje: string } {
    this.pausarSolicitado = true;
    this.enviando = false;
    this.mensajeEstado = 'Campaña pausada.';
    return { exito: true, mensaje: 'Se solicitó pausar la campaña.' };
  }

  private async guardarEnHistorial(registro: RegistroContacto) {
    try {
      const historial = await this.obtenerHistorial();
      historial.push(registro);
      await fs.writeFile(this.historialPath, JSON.stringify(historial, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error(`Error al guardar en historial: ${(error as Error).message}`);
    }
  }

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
   * Permite importar números ya contactados previamente para evitar repeticiones.
   */
  async importarContactados(telefonos: string[]): Promise<{ agregados: number; total: number }> {
    const historial = await this.obtenerHistorial();
    const yaRegistrados = new Set(historial.map((h) => h.telefono));
    let agregados = 0;

    for (const t of telefonos) {
      const limpio = t.replace(/[^\d]/g, '');
      if (limpio.length >= 8 && !yaRegistrados.has(limpio)) {
        historial.push({
          telefono: limpio,
          nombre: 'Importado manual',
          fecha: new Date().toISOString(),
          mensaje: 'Número contactado previamente (importado)',
        });
        yaRegistrados.add(limpio);
        agregados++;
      }
    }

    if (agregados > 0) {
      await fs.writeFile(this.historialPath, JSON.stringify(historial, null, 2), 'utf-8');
    }

    return { agregados, total: historial.length };
  }

  private async contarEnviadosHoy(): Promise<number> {
    const hoy = new Date().toISOString().slice(0, 10);
    const historial = await this.obtenerHistorial();
    return historial.filter((item) => item.fecha.startsWith(hoy)).length;
  }
}
