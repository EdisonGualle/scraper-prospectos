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
      if (!existsSync(this.sessionPath)) {
        await fs.mkdir(this.sessionPath, { recursive: true });
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

  isConectado(): boolean {
    return this.conectado;
  }

  isEnviando(): boolean {
    return this.enviando;
  }

  getTopeDiario(): number {
    return this.topeDiario;
  }

  /**
   * Normaliza cualquier formato de teléfono de Ecuador (+593, 09..., 9...)
   * para deduplicación robusta.
   */
  public static normalizarTelefono(tel?: string): { digitos: string; ultimos9: string; canonico: string } {
    if (!tel) return { digitos: '', ultimos9: '', canonico: '' };
    const digitos = tel.replace(/[^\d]/g, '');
    const ultimos9 = digitos.length >= 9 ? digitos.slice(-9) : digitos;
    const canonico = `593${ultimos9}`;
    return { digitos, ultimos9, canonico };
  }

  /**
   * Genera un Set con todas las variantes conocidas de los teléfonos ya contactados
   * en el historial persistido (data/contactados.json).
   */
  public async obtenerSetContactados(): Promise<Set<string>> {
    const historial = await this.obtenerHistorial();
    const set = new Set<string>();
    for (const h of historial) {
      const { digitos, ultimos9, canonico } = WhatsappService.normalizarTelefono(h.telefono);
      if (digitos) set.add(digitos);
      if (ultimos9) set.add(ultimos9);
      if (canonico) set.add(canonico);
    }
    return set;
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
          '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ],
      });

      const pages = await this.browser.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 850 });
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      );
      try {
        await this.page.bringToFront();
      } catch {}

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
   * Monitorea de forma continua si ya se autenticó o captura el QR en base64 para la interfaz web.
   */
  private iniciarMonitoreoAutenticacionYQr() {
    if (this.intervaloMonitoreo) {
      clearInterval(this.intervaloMonitoreo);
    }

    let intentos = 0;
    this.intervaloMonitoreo = setInterval(async () => {
      if (!this.page || this.page.isClosed()) {
        if (this.intervaloMonitoreo) clearInterval(this.intervaloMonitoreo);
        this.conectado = false;
        this.qrCode = null;
        return;
      }

      intentos++;

      try {
        // 1. Detectar si hay QR en pantalla (Usuario aún no autenticado)
        const canvasOrQr = await this.page.$(
          'div[data-ref], canvas[aria-label*="Scan"], canvas, div[role="button"]:has(canvas)',
        );
        if (canvasOrQr) {
          this.conectado = false;
          try {
            const qrBase64 = await canvasOrQr.screenshot({ encoding: 'base64' });
            this.qrCode = `data:image/png;base64,${qrBase64}`;
            this.mensajeEstado = 'Código QR listo. Escanéalo con tu celular en la pantalla o en la ventana de Chrome.';
          } catch {}

          // Si el QR expiró, hacer clic en recargar
          const reloadBtn = await this.page.$(
            'div[role="button"]:has(span[data-icon="refresh"]), span[data-icon="refresh"], button[aria-label*="recargar"], button[aria-label*="reload"]',
          );
          if (reloadBtn) {
            await reloadBtn.click();
            await new Promise((r) => setTimeout(r, 1000));
          }
          return;
        }

        // 2. Si no hay QR, verificar si ya cargó la interfaz autenticada de chats
        const panelChats = await this.page.$(
          '#pane-side, [data-icon="community"], header [data-icon="chat"], header [data-icon="status-outline"], div[aria-label="Chat list"], div[aria-label="Lista de chats"]',
        );
        if (panelChats) {
          this.conectado = true;
          this.qrCode = null;
          this.mensajeEstado = 'WhatsApp Web conectado exitosamente. ¡Listo para enviar!';
          this.logger.log('¡WhatsApp Web autenticado correctamente!');
          if (this.intervaloMonitoreo) clearInterval(this.intervaloMonitoreo);
          return;
        }

        // 3. En progreso de carga inicial
        this.mensajeEstado = 'Cargando WhatsApp Web... Por favor espera unos segundos.';

        // Si pasan 5 minutos sin escanear, detener
        if (intentos > 150) {
          this.mensajeEstado = 'Tiempo de espera para escanear QR agotado. Haz clic en Conectar nuevamente.';
          if (this.intervaloMonitoreo) clearInterval(this.intervaloMonitoreo);
        }
      } catch (err) {
        // Ignorar errores de navegación transitorios
      }
    }, 1500);
  }

  /**
   * Inicia la campaña manual de envíos automatizados en segundo plano.
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
    const telefonosContactadosSet = await this.obtenerSetContactados();

    const candidatos = prospectos.filter((p) => {
      if (!p.telefono || !p.whatsappUrl) return false;
      const { digitos, ultimos9, canonico } = WhatsappService.normalizarTelefono(p.telefono);
      return (
        !telefonosContactadosSet.has(digitos) &&
        !telefonosContactadosSet.has(ultimos9) &&
        !telefonosContactadosSet.has(canonico)
      );
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
   * Procesa un lote de prospectos sincrónicamente (espera a que termine el lote actual).
   */
  async procesarLoteProspectos(
    prospectos: ProspectoDto[],
    opciones?: {
      plantillas?: string[];
      mensajePersonalizado?: string;
      archivoAdjuntoPath?: string;
      archivosAdjuntosPaths?: string[];
      tipoAdjunto?: 'foto' | 'documento';
    },
  ): Promise<{ exito: boolean; mensaje: string; enviados: number; topeAlcanzado: boolean; cancelado: boolean }> {
    if (!this.conectado || !this.page) {
      return {
        exito: false,
        mensaje: 'Primero debes conectar WhatsApp Web y escanear el código QR.',
        enviados: 0,
        topeAlcanzado: false,
        cancelado: false,
      };
    }

    if (this.enviando) {
      return {
        exito: false,
        mensaje: 'Ya hay una campaña de envíos en ejecución.',
        enviados: 0,
        topeAlcanzado: false,
        cancelado: false,
      };
    }

    const enviadosHoy = await this.contarEnviadosHoy();
    if (enviadosHoy >= this.topeDiario) {
      return {
        exito: false,
        mensaje: `Ya alcanzaste el tope seguro de ${this.topeDiario} mensajes para hoy.`,
        enviados: 0,
        topeAlcanzado: true,
        cancelado: false,
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

    const telefonosContactadosSet = await this.obtenerSetContactados();

    const candidatos = prospectos.filter((p) => {
      if (!p.telefono || !p.whatsappUrl) return false;
      const { digitos, ultimos9, canonico } = WhatsappService.normalizarTelefono(p.telefono);
      return (
        !telefonosContactadosSet.has(digitos) &&
        !telefonosContactadosSet.has(ultimos9) &&
        !telefonosContactadosSet.has(canonico)
      );
    });

    if (candidatos.length === 0) {
      return {
        exito: true,
        mensaje: 'No hay prospectos nuevos en este lote.',
        enviados: 0,
        topeAlcanzado: false,
        cancelado: false,
      };
    }

    this.enviando = true;
    this.pausarSolicitado = false;
    const res = await this.ejecutarColaEnvios(candidatos);

    return {
      exito: true,
      mensaje: `Lote procesado: ${res.enviados} enviados.`,
      enviados: res.enviados,
      topeAlcanzado: res.topeAlcanzado,
      cancelado: res.cancelado,
    };
  }

  /**
   * Bucle asíncrono que procesa la cola con intervalos aleatorios.
   */
  private async ejecutarColaEnvios(
    candidatos: ProspectoDto[],
  ): Promise<{ enviados: number; topeAlcanzado: boolean; cancelado: boolean }> {
    let index = 0;
    let enviadosExitosos = 0;
    let topeAlcanzado = false;

    for (const prospecto of candidatos) {
      if (this.pausarSolicitado) {
        this.mensajeEstado = 'Campaña pausada por el usuario.';
        this.logger.log('Campaña pausada por solicitud del usuario.');
        break;
      }

      const totalHoy = await this.contarEnviadosHoy();
      if (totalHoy >= this.topeDiario) {
        topeAlcanzado = true;
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
        enviadosExitosos++;
        const nuevosEnviados = await this.contarEnviadosHoy();
        this.logger.log(
          `[${nuevosEnviados}/${this.topeDiario}] Enviado exitosamente a: ${prospecto.nombre} (${prospecto.telefono})`,
        );
      }

      // Si aún quedan prospectos, esperar un tiempo aleatorio humano (20 a 45 seg)
      if (index < candidatos.length && !this.pausarSolicitado) {
        const totalTrasEnvio = await this.contarEnviadosHoy();
        if (totalTrasEnvio >= this.topeDiario) {
          topeAlcanzado = true;
          this.mensajeEstado = `Tope diario de ${this.topeDiario} envíos alcanzado.`;
          break;
        }

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
    if (!this.pausarSolicitado && !topeAlcanzado) {
      this.mensajeEstado = 'Campaña de este lote finalizada exitosamente.';
    }

    return {
      enviados: enviadosExitosos,
      topeAlcanzado,
      cancelado: this.pausarSolicitado,
    };
  }

  /**
   * Envía un mensaje individual en WhatsApp Web y adjunta múltiples imágenes/archivos.
   */
  public async enviarMensajeProspecto(
    prospecto: ProspectoDto,
    opcionesOverride?: {
      plantillas?: string[];
      mensajePersonalizado?: string;
      archivoAdjuntoPath?: string;
      archivosAdjuntosPaths?: string[];
      tipoAdjunto?: 'foto' | 'documento';
    },
  ): Promise<boolean> {
    if (!this.page || !prospecto.telefono) return false;

    const opciones = opcionesOverride || this.opcionesCampana;

    // Normalizar número telefónico internacional para Ecuador (5939...)
    const numLimpio = prospecto.telefono.replace(/[^\d]/g, '');
    const telefonoEcuador = numLimpio.startsWith('593')
      ? numLimpio
      : numLimpio.startsWith('0')
        ? `593${numLimpio.slice(1)}`
        : `593${numLimpio}`;

    // 1. Obtener la plantilla a usar: si hay lista de plantillas, rotar aleatoriamente
    let plantillaSeleccionada = '';
    const plantillasValidas = (opciones?.plantillas || []).filter(
      (p) => p && p.trim().length > 0,
    );

    if (plantillasValidas.length > 0) {
      const indice = Math.floor(Math.random() * plantillasValidas.length);
      plantillaSeleccionada = plantillasValidas[indice];
    } else if (
      opciones?.mensajePersonalizado &&
      opciones.mensajePersonalizado.trim().length > 0
    ) {
      plantillaSeleccionada = opciones.mensajePersonalizado;
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
      const archivos = opciones?.archivosAdjuntosPaths || [];
      const archivosValidos = archivos.filter((p) => existsSync(p));

      if (archivosValidos.length > 0) {
        try {
          const modoEnvio = opciones?.tipoAdjunto || 'foto';
          const hayPdfs = archivosValidos.some(
            (p) => p.toLowerCase().endsWith('.pdf') || p.toLowerCase().endsWith('.docx'),
          );
          const enviarComoDocumento = hayPdfs || modoEnvio === 'documento';
          const modoTexto = enviarComoDocumento ? 'documento' : 'foto';

          this.logger.log(
            `Adjuntando ${archivosValidos.length} archivo(s) para ${prospecto.nombre} (Modo: ${modoTexto})...`,
          );

          // 1. Abrir menú de adjuntos (+) en WhatsApp Web
          const attachBtnSelector =
            'button[aria-label="Adjuntar"], button[title*="Adjuntar"], span[data-icon="plus-rounded"], [data-testid="plus-rounded"], span[data-icon="plus"]';

          const btnAdjuntar = await this.page.$(attachBtnSelector);
          if (btnAdjuntar) {
            await this.page.evaluate((el) => {
              const btn = (el as HTMLElement).closest('button') || el;
              (btn as HTMLElement).click();
            }, btnAdjuntar);
          } else {
            // Intentar con el primer botón de la barra inferior
            await this.page.evaluate(() => {
              const b = document.querySelector('footer button') as HTMLElement;
              if (b) b.click();
            });
          }

          // Breve pausa para que se despliegue el menú flotante
          await new Promise((r) => setTimeout(r, 1200));

          const labelBuscado = enviarComoDocumento ? 'documento' : 'fotos y videos';
          let archivoCargado = false;

          // Método A: interceptar el diálogo de archivos del sistema al hacer clic en el ítem del menú
          try {
            const [fileChooser] = await Promise.all([
              this.page.waitForFileChooser({ timeout: 5000 }).catch(() => null),
              this.page.evaluate((targetLabel) => {
                const items = Array.from(
                  document.querySelectorAll('button[role="menuitem"], li[role="button"], [role="menu"] button, div[role="button"]'),
                );
                const item = items.find((el) => {
                  const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                  const txt = ((el as HTMLElement).innerText || '').toLowerCase();
                  return aria.includes(targetLabel) || txt.includes(targetLabel);
                }) as HTMLElement;
                if (item) item.click();
              }, labelBuscado),
            ]);

            if (fileChooser) {
              await fileChooser.accept(archivosValidos);
              archivoCargado = true;
              this.logger.log(`Archivos cargados exitosamente vía fileChooser nativo (${labelBuscado}).`);
            }
          } catch (fcErr) {
            this.logger.warn(`FileChooser timeout o no disponible: ${(fcErr as Error).message}`);
          }

          // Método B: Fallback directo cargando en los inputs de archivo del DOM
          if (!archivoCargado) {
            await new Promise((r) => setTimeout(r, 1200));
            const allInputs = await this.page.$$('input[type="file"]');
            for (const inp of allInputs) {
              const accept = await inp.evaluate((el) => ((el as HTMLInputElement).accept || '').toLowerCase());
              // Evitar estrictamente el creador de stickers webp
              if (accept.includes('webp') && !accept.includes('video')) continue;

              const coincide = enviarComoDocumento
                ? accept === '*' || accept === '' || accept.includes('application')
                : accept.includes('video') || accept.includes('image');

              if (coincide) {
                await inp.uploadFile(...archivosValidos);
                archivoCargado = true;
                this.logger.log(`Archivos cargados exitosamente vía uploadFile en input (${accept}).`);
                break;
              }
            }
          }

          if (archivoCargado) {
            // Esperar al botón verde de envío en la vista previa de medios
            const sendMediaBtnSelector =
              'span[data-icon="send"], div[aria-label*="Enviar"], button[aria-label*="Enviar"], [data-testid="send"]';
            await this.page.waitForSelector(sendMediaBtnSelector, { timeout: 25000 });
            await new Promise((r) => setTimeout(r, 1500));

            const sendBtn = await this.page.$(sendMediaBtnSelector);
            if (sendBtn) {
              await this.page.evaluate((el) => {
                const btn = (el as HTMLElement).closest('button') || el;
                (btn as HTMLElement).click();
              }, sendBtn);
            } else {
              await this.page.keyboard.press('Enter');
            }
            await new Promise((r) => setTimeout(r, 4000));
            this.logger.log(
              `Archivos (${archivosValidos.length}) enviados exitosamente como imagen/documento real a "${prospecto.nombre}".`,
            );
          } else {
            this.logger.warn('No se pudo cargar el archivo por ninguno de los métodos disponibles en WhatsApp Web.');
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

  /**
   * Envía un mensaje de prueba a un número específico para verificar textos y fotos sin stickers.
   */
  public async enviarMensajePrueba(
    telefono: string,
    opciones?: {
      mensaje?: string;
      archivosAdjuntosPaths?: string[];
      tipoAdjunto?: 'foto' | 'documento';
    },
  ): Promise<{ exito: boolean; mensaje: string }> {
    if (!this.conectado || !this.page) {
      return {
        exito: false,
        mensaje: 'WhatsApp Web no está conectado. Por favor conecta WhatsApp primero.',
      };
    }

    const telLimpio = telefono.replace(/[^\d]/g, '');
    if (telLimpio.length < 8) {
      return {
        exito: false,
        mensaje: 'Ingresa un número telefónico válido (ej. 0991234567 o 593991234567).',
      };
    }

    const prospectoTest: ProspectoDto = {
      nombre: 'Prueba de Sistema',
      telefono: telLimpio,
      direccion: 'Ecuador',
      categoria: 'Tienda de Ropa',
      terminoBusqueda: 'prueba',
      fechaCaptura: new Date().toISOString(),
    };

    this.logger.log(`Iniciando envío de prueba a: ${telLimpio}...`);

    try {
      const exito = await this.enviarMensajeProspecto(prospectoTest, {
        mensajePersonalizado: opciones?.mensaje || '¡Hola {nombre}! Este es un mensaje de prueba de CodeCima.',
        archivosAdjuntosPaths: opciones?.archivosAdjuntosPaths,
        tipoAdjunto: opciones?.tipoAdjunto || 'foto',
      });

      if (exito) {
        return {
          exito: true,
          mensaje: `✅ Mensaje de prueba enviado exitosamente al número ${telefono}.`,
        };
      } else {
        return {
          exito: false,
          mensaje: `No se pudo enviar el mensaje a ${telefono}. Verifica si el número tiene WhatsApp activo.`,
        };
      }
    } catch (err) {
      return {
        exito: false,
        mensaje: `Error al enviar prueba: ${(err as Error).message}`,
      };
    }
  }

  public async debugAdjuntos(telefono?: string) {
    if (!this.page) return { error: 'No hay página activa' };

    if (telefono) {
      const sendUrl = `https://web.whatsapp.com/send?phone=${telefono}`;
      await this.page.goto(sendUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 35000,
      });
      const chatInputSelector =
        'div[contenteditable="true"][data-tab="10"], footer div[contenteditable="true"], div[role="textbox"]';
      await this.page.waitForSelector(chatInputSelector, { timeout: 25000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
    }

    // Inspeccionar antes de hacer click
    const antesDeClick = await this.page.evaluate(() => {
      const chatButtons = Array.from(document.querySelectorAll('footer button, div[role="textbox"] ~ * button, [data-icon]')).map((el) => {
        const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
        return {
          tag: el.tagName,
          icon: el.getAttribute('data-icon'),
          ariaLabel: el.getAttribute('aria-label') || btn?.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || btn?.getAttribute('title') || '',
          btnOuter: btn?.outerHTML.slice(0, 150) || el.outerHTML.slice(0, 150),
        };
      });

      const inputsAntes = Array.from(document.querySelectorAll('input[type="file"]')).map((inp, idx) => ({
        idx,
        accept: (inp as HTMLInputElement).accept,
        outerHTML: inp.outerHTML,
      }));

      return { chatButtons: chatButtons.slice(0, 30), inputsAntes };
    });

    // Intentar hacer click en el botón de adjuntar
    const clickResultado = await this.page.evaluate(() => {
      const posibles = [
        document.querySelector('button[aria-label="Adjuntar"]'),
        document.querySelector('button[title*="Adjuntar"]'),
        document.querySelector('[data-icon="plus-rounded"]')?.closest('button'),
        document.querySelector('[data-icon="plus"]')?.closest('button'),
        document.querySelector('[data-icon="attach-menu-plus"]')?.closest('button'),
        document.querySelector('[data-icon="clip"]')?.closest('button'),
        document.querySelector('footer button:first-child'),
      ].filter(Boolean);

      if (posibles.length > 0) {
        const target = posibles[0] as HTMLElement;
        target.click();
        return { encontrado: true, html: target.outerHTML.slice(0, 200) };
      }
      return { encontrado: false };
    });

    // Esperar a que se abra el menú
    await new Promise((r) => setTimeout(r, 2000));

    // Inspeccionar después de hacer click
    const despuesDeClick = await this.page.evaluate(() => {
      const menuButtons = Array.from(
        document.querySelectorAll('button[role="menuitem"], li[role="button"], [role="menu"] *')
      ).map((el) => ({
        tag: el.tagName,
        ariaLabel: el.getAttribute('aria-label') || '',
        text: ((el as HTMLElement).innerText || '').trim(),
        html: el.outerHTML.slice(0, 300),
        hasInput: !!el.querySelector('input[type="file"]'),
        inputHtml: el.querySelector('input[type="file"]')?.outerHTML || '',
      }));

      // Buscar todos los inputs de tipo file en toda la página
      const allInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((inp, idx) => ({
        idx,
        accept: (inp as HTMLInputElement).accept,
        outer: inp.outerHTML,
        parentTag: inp.parentElement?.tagName,
        parentHtml: inp.parentElement?.outerHTML.slice(0, 200),
      }));

      return { menuButtons, allInputs };
    });

    // Probar hacer clic en 'Fotos y videos' capturando con waitForFileChooser
    let fileChooserDisparado = false;
    let errorFileChooser = '';
    try {
      const [fileChooser] = await Promise.all([
        this.page.waitForFileChooser({ timeout: 4000 }).catch((e) => {
          errorFileChooser = (e as Error).message;
          return null;
        }),
        this.page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button[role="menuitem"], li, button')).find((b) => {
            const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
            const txt = ((b as HTMLElement).innerText || '').toLowerCase();
            return lbl.includes('fotos y videos') || txt.includes('fotos y videos');
          }) as HTMLElement;
          if (btn) btn.click();
        }),
      ]);

      if (fileChooser) {
        fileChooserDisparado = true;
      }
    } catch (e) {
      errorFileChooser = (e as Error).message;
    }

    // Ver si después de hacer click en Fotos y videos apareció algún input o modal
    const estadoFinal = await this.page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map((inp, idx) => ({
        idx,
        accept: (inp as HTMLInputElement).accept,
        outer: inp.outerHTML,
      }));
      return { inputs, modales: document.querySelectorAll('[role="dialog"]').length };
    });

    return { antesDeClick, clickResultado, despuesDeClick, fileChooserDisparado, errorFileChooser, estadoFinal };
  }

  public async contarEnviadosHoy(): Promise<number> {
    const hoy = new Date().toISOString().slice(0, 10);
    const historial = await this.obtenerHistorial();
    return historial.filter((item) => item.fecha.startsWith(hoy)).length;
  }
}
