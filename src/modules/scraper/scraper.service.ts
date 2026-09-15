import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer from 'puppeteer-extra';
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
import { Browser, Page } from 'puppeteer';
import { ProspectoDto } from './dto/prospecto.dto';
import { PhoneUtil } from '../../common/utils/phone.util';
import { BusinessFilterUtil } from '../../common/utils/business-filter.util';

export interface OpcionesProspeccion {
  soloConWhatsapp?: boolean;
  excluirGrandesCadenas?: boolean;
  maxResenas?: number;
  soloNuevosOPequenos?: boolean;
  soloDel2026?: boolean;
}

export interface MetricasProspeccion {
  totalEvaluados: number;
  descartadosPorCadena: number;
  descartadosPorMadurez: number;
  descartadosSinWhatsapp: number;
  validos: number;
  localesNuevos: number;
}

export interface ResultadoProspeccion {
  prospectos: ProspectoDto[];
  metricas: MetricasProspeccion;
}

// Activar plugin stealth para emular comportamiento de navegador humano y evitar bloqueos
puppeteer.use(StealthPlugin());

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Inicializa una instancia de navegador con configuración sigilosa.
   */
  private async iniciarNavegador(): Promise<Browser> {
    const isHeadless =
      process.env.PUPPETEER_HEADLESS === 'false' ? false : ('new' as any);

    return puppeteer.launch({
      headless: isHeadless,
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        this.config.get<string>('PUPPETEER_EXECUTABLE_PATH') ||
        undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1366,768',
      ],
    });
  }

  /**
   * Realiza la búsqueda y extracción de prospectos comerciales en Google Maps.
   */
  async buscarProspectos(
    query: string,
    limite: number = 30,
    opciones: OpcionesProspeccion = {},
  ): Promise<ResultadoProspeccion> {
    const soloConWhatsapp = opciones.soloConWhatsapp !== false;
    const excluirGrandesCadenas = opciones.excluirGrandesCadenas !== false;
    const maxResenas = opciones.maxResenas !== undefined ? opciones.maxResenas : 20;
    const soloNuevosOPequenos = opciones.soloNuevosOPequenos !== false;
    const soloDel2026 = opciones.soloDel2026 !== false;

    this.logger.log(
      `Iniciando prospección en Google Maps para: "${query}" (Objetivo: ${limite} PyMEs | Max Reseñas: ${maxResenas} | Solo 2026: ${soloDel2026} | Solo WhatsApp: ${soloConWhatsapp} | Excluir Cadenas: ${excluirGrandesCadenas})`,
    );

    const browser = await this.iniciarNavegador();
    const page = await browser.newPage();

    await page.setViewport({ width: 1366, height: 768 });

    const prospectos: ProspectoDto[] = [];
    const seenNames = new Set<string>();

    const metricas: MetricasProspeccion = {
      totalEvaluados: 0,
      descartadosPorCadena: 0,
      descartadosPorMadurez: 0,
      descartadosSinWhatsapp: 0,
      validos: 0,
      localesNuevos: 0,
    };

    try {
      // 1. Navegar directamente a la búsqueda de Google Maps con idioma en español
      const targetUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=es`;
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // 2. Gestionar diálogo de consentimiento de Google si se presenta
      await this.manejarConsentimiento(page);

      // 3. Esperar a que cargue el feed de resultados o un único resultado directo
      try {
        await page.waitForSelector('div[role="feed"], .Nv2PK, h1.DUwDvf', {
          timeout: 15000,
        });
      } catch (err) {
        this.logger.warn(
          'No se detectó el feed de resultados en el tiempo esperado. Verificando contenido...',
        );
      }

      // Caso A: Google Maps redirigió directamente a la ficha de un solo negocio
      const esFichaDirecta = (await page.$('h1.DUwDvf')) !== null;
      if (esFichaDirecta && (await page.$('div[role="feed"]')) === null) {
        this.logger.log('Se detectó una ficha única de negocio directa.');
        const unico = await this.extraerDetalleFicha(page, query);
        if (unico) {
          metricas.totalEvaluados++;
          let valido = true;

          const evaluacion = BusinessFilterUtil.evaluarProspecto(
            unico.nombre,
            unico.categoria,
            unico.totalResenas,
            [],
            unico.sitioWeb,
            maxResenas,
            soloNuevosOPequenos,
            soloDel2026,
            unico.fechasResenas || [],
          );

          if (!evaluacion.esCandidatoValido) {
            if (evaluacion.motivoDescarte?.includes('Gran cadena')) {
              metricas.descartadosPorCadena++;
            } else {
              metricas.descartadosPorMadurez++;
            }
            valido = false;
          }

          if (valido && soloConWhatsapp && !unico.whatsappUrl) {
            metricas.descartadosSinWhatsapp++;
            valido = false;
          }

          if (valido) {
            unico.esNuevo = evaluacion.esNuevo;
            unico.esDel2026 = evaluacion.esNuevo || (unico.totalResenas !== undefined && unico.totalResenas <= 20);
            unico.oportunidad = evaluacion.oportunidad;
            if (evaluacion.esNuevo) metricas.localesNuevos++;
            prospectos.push(unico);
            metricas.validos = 1;
          }
        }
        return { prospectos, metricas };
      }

      // Caso B: Tenemos el listado de resultados (Feed)
      const feedSelector = 'div[role="feed"]';
      const existeFeed = (await page.$(feedSelector)) !== null;

      if (!existeFeed) {
        this.logger.warn('No se encontró el contenedor de resultados (feed).');
        return { prospectos, metricas };
      }

      // 4. Scroll progresivo: cargamos suficientes tarjetas para compensar los descartes
      const tarjetasObjetivo = Math.min(Math.max(limite * 3, 30), 120);
      this.logger.log(
        `Cargando lista de negocios con desplazamiento progresivo (Buscando ~${tarjetasObjetivo} candidatos)...`,
      );
      await this.scrollFeed(page, feedSelector, tarjetasObjetivo);

      // 5. Obtener elementos de negocio disponibles en el feed
      const totalTarjetasDetectadas = await page.$$eval(
        'div.Nv2PK',
        (el) => el.length,
      );
      this.logger.log(
        `Tarjetas cargadas en el feed: ${totalTarjetasDetectadas}`,
      );

      for (let i = 0; i < totalTarjetasDetectadas; i++) {
        if (prospectos.length >= limite) break;

        try {
          const elementosActuales = await page.$$('div.Nv2PK');
          if (i >= elementosActuales.length) break;

          const tarjeta = elementosActuales[i];

          // Extraer información básica visible
          const basicInfo = await tarjeta.evaluate((el) => {
            const nombreEl =
              el.querySelector('.qBF1Pd') || el.querySelector('.fontHeadlineSmall');
            const nombre = nombreEl ? nombreEl.textContent?.trim() : '';

            const ratingEl = el.querySelector('.MW4etd');
            const reviewsEl = el.querySelector('.UY7F9');
            const ratingText = ratingEl ? ratingEl.textContent?.trim() : null;
            const reviewsText = reviewsEl
              ? reviewsEl.textContent?.replace(/[^\d]/g, '')
              : null;

            const linkEl = el.querySelector('a.hfpxzc') as HTMLAnchorElement;
            const mapsUrl = linkEl ? linkEl.href : '';

            const lineasTexto = Array.from(el.querySelectorAll('.W4Efsd')).map(
              (s) => s.textContent?.trim() || '',
            );

            return {
              nombre,
              rating: ratingText ? parseFloat(ratingText.replace(',', '.')) : undefined,
              totalResenas: reviewsText ? parseInt(reviewsText, 10) : undefined,
              mapsUrl,
              lineasTexto,
            };
          });

          if (!basicInfo.nombre || seenNames.has(basicInfo.nombre.toLowerCase())) {
            continue;
          }

          seenNames.add(basicInfo.nombre.toLowerCase());
          metricas.totalEvaluados++;

          const categoriaPreliminar = this.deducirCategoria(basicInfo.lineasTexto);

          // FILTRO 1: Descartar grandes cadenas y negocios muy consolidados (> maxReseñas)
          const evaluacionPreliminar = BusinessFilterUtil.evaluarProspecto(
            basicInfo.nombre,
            categoriaPreliminar,
            basicInfo.totalResenas,
            basicInfo.lineasTexto,
            undefined,
            maxResenas,
            soloNuevosOPequenos,
            soloDel2026,
            basicInfo.lineasTexto,
          );

          if (!evaluacionPreliminar.esCandidatoValido) {
            if (evaluacionPreliminar.motivoDescarte?.includes('Gran cadena')) {
              metricas.descartadosPorCadena++;
            } else {
              metricas.descartadosPorMadurez++;
            }
            this.logger.log(
              `[Descartado]: "${basicInfo.nombre}" -> ${evaluacionPreliminar.motivoDescarte}`,
            );
            continue;
          }

          // Clic para desplegar detalles (teléfono, web, etc.)
          await tarjeta.scrollIntoView();
          await tarjeta.click();
          await new Promise((r) => setTimeout(r, 1000));

          const detalles = await this.extraerDatosPanelLateral(page);
          const { telefonoFormateado, esCelular, whatsappUrl } =
            PhoneUtil.normalizarTelefono(detalles.telefono);

          // FILTRO 2: Descartar los que NO tengan WhatsApp / celular
          if (soloConWhatsapp && !whatsappUrl) {
            metricas.descartadosSinWhatsapp++;
            this.logger.log(
              `[Descartado - Sin WhatsApp]: "${basicInfo.nombre}" (Tel: ${telefonoFormateado || 'Sin número'})`,
            );
            continue;
          }

          // Combinar fechas del panel lateral con textos del feed
          const fechasParaEvaluar = [
            ...(detalles.fechasResenas || []),
            ...basicInfo.lineasTexto,
          ];

          // Evaluación final con sitio web detectado y fechas de reseñas
          const evaluacionFinal = BusinessFilterUtil.evaluarProspecto(
            basicInfo.nombre,
            detalles.categoria || categoriaPreliminar,
            basicInfo.totalResenas,
            basicInfo.lineasTexto,
            detalles.sitioWeb,
            maxResenas,
            soloNuevosOPequenos,
            soloDel2026,
            fechasParaEvaluar,
          );

          if (!evaluacionFinal.esCandidatoValido) {
            metricas.descartadosPorMadurez++;
            this.logger.log(
              `[Descartado - Panel lateral]: "${basicInfo.nombre}" -> ${evaluacionFinal.motivoDescarte}`,
            );
            continue;
          }

          if (evaluacionFinal.esNuevo) {
            metricas.localesNuevos++;
          }

          // Prospecto calificado
          const prospecto: ProspectoDto = {
            nombre: basicInfo.nombre,
            categoria: detalles.categoria || categoriaPreliminar,
            telefono: telefonoFormateado,
            esCelular,
            whatsappUrl,
            sitioWeb: detalles.sitioWeb,
            direccion: detalles.direccion || basicInfo.lineasTexto[0],
            calificacion: basicInfo.rating,
            totalResenas: basicInfo.totalResenas,
            mapsUrl: basicInfo.mapsUrl || page.url(),
            terminoBusqueda: query,
            fechaCaptura: new Date().toISOString(),
            esNuevo: evaluacionFinal.esNuevo,
            esDel2026: evaluacionFinal.esNuevo || (basicInfo.totalResenas !== undefined && basicInfo.totalResenas <= 20),
            oportunidad: evaluacionFinal.oportunidad,
          };

          prospectos.push(prospecto);
          metricas.validos = prospectos.length;

          this.logger.log(
            `[${prospectos.length}/${limite}] Prospecto PyME Aprobado [${prospecto.oportunidad}]: ${prospecto.nombre} | Reseñas: ${prospecto.totalResenas || 0} | Cel: ${prospecto.telefono} | WA: ${prospecto.whatsappUrl}`,
          );
        } catch (itemError) {
          this.logger.warn(
            `Error al procesar tarjeta en índice ${i}: ${(itemError as Error).message}`,
          );
        }
      }

      this.logger.log(
        `Prospección finalizada. Evaluados: ${metricas.totalEvaluados} | Cadenas descartadas: ${metricas.descartadosPorCadena} | Sin WA descartados: ${metricas.descartadosSinWhatsapp} | Válidos finales: ${prospectos.length}`,
      );

      return { prospectos, metricas };
    } catch (error) {
      this.logger.error(
        `Error general durante la prospección: ${(error as Error).message}`,
      );
      throw error;
    } finally {
      await browser.close();
    }
  }

  /**
   * Resuelve o cierra modales de cookies / privacidad de Google si se presentan.
   */
  private async manejarConsentimiento(page: Page) {
    try {
      const botonAceptar = await page.evaluate(() => {
        const botones = Array.from(document.querySelectorAll('button'));
        const target = botones.find((b) => {
          const t = (b.textContent || '').toLowerCase().trim();
          return (
            t.includes('aceptar todo') ||
            t.includes('accept all') ||
            t.includes('rechazar todo') ||
            t.includes('reject all')
          );
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      });

      if (botonAceptar) {
        this.logger.log('Se aceptó el diálogo de consentimiento de Google.');
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch {
      // Ignorar si no aparece
    }
  }

  /**
   * Desplaza el feed de resultados hacia abajo para forzar la carga de más locales.
   */
  private async scrollFeed(page: Page, feedSelector: string, limite: number) {
    let intentosSinNuevos = 0;
    let totalAnterior = 0;

    for (let s = 0; s < 15; s++) {
      const count = await page.$$eval(
        'div.Nv2PK',
        (elementos) => elementos.length,
      );

      if (count >= limite) {
        break;
      }

      if (count === totalAnterior) {
        intentosSinNuevos++;
        if (intentosSinNuevos >= 3) break;
      } else {
        intentosSinNuevos = 0;
      }

      totalAnterior = count;

      // Scroll en el contenedor feed
      await page.evaluate((selector) => {
        const feed = document.querySelector(selector);
        if (feed) {
          feed.scrollTop = feed.scrollHeight;
        }
      }, feedSelector);

      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));

      // Verificar si Google Maps llegó al final del listado
      const llegoAlFinal = await page.evaluate(() => {
        return (
          document.body.innerText.includes('Llegaste al final de la lista') ||
          document.body.innerText.includes("You've reached the end of the list")
        );
      });

      if (llegoAlFinal) break;
    }
  }

  /**
   * Extrae los datos detallados del panel lateral de un negocio seleccionado.
   */
  private async extraerDatosPanelLateral(page: Page): Promise<{
    telefono?: string;
    sitioWeb?: string;
    direccion?: string;
    categoria?: string;
    fechasResenas: string[];
  }> {
    return page.evaluate(() => {
      // Categoría
      const catBtn = document.querySelector('button[jsaction*="category"]');
      const categoria = catBtn ? catBtn.textContent?.trim() : undefined;

      // Dirección
      const dirBtn = document.querySelector('button[data-item-id="address"]');
      const direccion = dirBtn
        ? dirBtn.getAttribute('aria-label')?.replace(/^Dirección:\s*/i, '').trim() ||
          dirBtn.textContent?.trim()
        : undefined;

      // Teléfono: buscar botón con data-item-id="phone:tel:..." o icono de teléfono
      let telefono: string | undefined;
      const telBtn =
        document.querySelector('button[data-item-id^="phone:tel:"]') ||
        document.querySelector('button[aria-label*="Teléfono"]') ||
        document.querySelector('button[aria-label*="Phone"]');

      if (telBtn) {
        const aria = telBtn.getAttribute('aria-label');
        if (aria) {
          telefono = aria.replace(/^(Teléfono|Phone):\s*/i, '').trim();
        } else {
          telefono = telBtn.textContent?.trim();
        }
      }

      // Sitio Web: buscar botón con enlace o data-item-id="authority"
      let sitioWeb: string | undefined;
      const webEl =
        (document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement) ||
        (document.querySelector('a[aria-label*="Sitio web"]') as HTMLAnchorElement);

      if (webEl && webEl.href) {
        sitioWeb = webEl.href;
      }

      // Fechas de reseñas visibles en el panel lateral
      const fechaElements = Array.from(
        document.querySelectorAll(
          '.rsqaWe, span[class*="date"], .bJCr1d, div[class*="fontBodySmall"] span',
        ),
      );
      const fechasResenas = fechaElements
        .map((el) => el.textContent?.trim() || '')
        .filter((texto) => {
          const t = texto.toLowerCase();
          return (
            t.includes('año') ||
            t.includes('ano') ||
            t.includes('mes') ||
            t.includes('semana') ||
            t.includes('días') ||
            t.includes('dias') ||
            /\b(201\d|202[0-5])\b/.test(t)
          );
        });

      return { telefono, sitioWeb, direccion, categoria, fechasResenas };
    });
  }

  /**
   * Extrae la información si Google Maps cargó directamente una ficha única.
   */
  private async extraerDetalleFicha(
    page: Page,
    query: string,
  ): Promise<(ProspectoDto & { fechasResenas?: string[] }) | null> {
    const nombre = await page.$eval('h1.DUwDvf', (el) => el.textContent?.trim());
    if (!nombre) return null;

    const ratingInfo = await page.evaluate(() => {
      const rEl = document.querySelector('.MW4etd');
      const revEl = document.querySelector('.UY7F9');
      return {
        rating: rEl ? parseFloat(rEl.textContent?.replace(',', '.') || '0') : undefined,
        reviews: revEl ? parseInt(revEl.textContent?.replace(/[^\d]/g, '') || '0', 10) : undefined,
      };
    });

    const detalles = await this.extraerDatosPanelLateral(page);
    const { telefonoFormateado, esCelular, whatsappUrl } =
      PhoneUtil.normalizarTelefono(detalles.telefono);

    return {
      nombre,
      categoria: detalles.categoria,
      telefono: telefonoFormateado,
      esCelular,
      whatsappUrl,
      sitioWeb: detalles.sitioWeb,
      direccion: detalles.direccion,
      calificacion: ratingInfo.rating,
      totalResenas: ratingInfo.reviews,
      mapsUrl: page.url(),
      terminoBusqueda: query,
      fechaCaptura: new Date().toISOString(),
      fechasResenas: detalles.fechasResenas,
    };
  }

  private deducirCategoria(lineas: string[]): string | undefined {
    if (!lineas || lineas.length === 0) return undefined;
    const primera = lineas[0];
    const partes = primera.split('·');
    return partes.length > 0 ? partes[0].trim() : undefined;
  }
}
