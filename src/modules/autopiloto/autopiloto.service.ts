import { Injectable, Logger } from '@nestjs/common';
import { ScraperService } from '../scraper/scraper.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { IniciarAutopilotoDto } from './dto/iniciar-autopiloto.dto';
import { ProspectoDto } from '../scraper/dto/prospecto.dto';

export interface HistorialTemaItem {
  tema: string;
  encontrados: number;
  nuevos: number;
  enviados: number;
  fecha: string;
}

export interface EstadoAgenteScraper {
  fase: 'inactivo' | 'escrapeando' | 'pausa_enfriamiento' | 'completado' | 'pausado' | 'error';
  temaActual: string;
  indiceTemaActual: number;
  totalTemas: number;
  prospectosEncontradosTotal: number;
  prospectosEncoladosTotal: number;
  tiempoRestantePausaSegundos: number;
  mensaje: string;
}

export interface EstadoAgenteWhatsApp {
  fase: 'inactivo' | 'enviando' | 'pausa_humana' | 'esperando_cola' | 'completado' | 'pausado' | 'error';
  prospectoActual?: string;
  enviadosHoy: number;
  enviadosEnSesion: number;
  topeDiario: number;
  tiempoSiguienteSegundos: number;
  mensaje: string;
}

export interface EstadoAutopiloto {
  activo: boolean;
  pausado: boolean;
  faseGlobal: 'inactivo' | 'ejecutando' | 'pausado' | 'completado' | 'error';
  mensajeEstado: string;
  agenteScraper: EstadoAgenteScraper;
  agenteWhatsApp: EstadoAgenteWhatsApp;
  colaPendientes: number;
  historialTemas: HistorialTemaItem[];
}

@Injectable()
export class AutopilotoService {
  private readonly logger = new Logger(AutopilotoService.name);

  // Estados de control general
  private activo = false;
  private pausado = false;
  private detenerSolicitado = false;
  private scraperCompletado = false;
  private faseGlobal: EstadoAutopiloto['faseGlobal'] = 'inactivo';
  private mensajeEstado = 'Auto-Piloto inactivo. Configura tu lista de temas y presiona Iniciar.';

  // Cola compartida en tiempo real (Buffer Productor-Consumidor)
  private colaProspectos: ProspectoDto[] = [];
  private telefonosEncolados: Set<string> = new Set();
  private historialTemas: HistorialTemaItem[] = [];

  // Estado del Agente 1: Explorador / Scraper de Google Maps
  private estadoAgenteScraper: EstadoAgenteScraper = {
    fase: 'inactivo',
    temaActual: '',
    indiceTemaActual: 0,
    totalTemas: 0,
    prospectosEncontradosTotal: 0,
    prospectosEncoladosTotal: 0,
    tiempoRestantePausaSegundos: 0,
    mensaje: 'Agente 1 en espera.',
  };

  // Estado del Agente 2: Despachador / Mensajero WhatsApp
  private estadoAgenteWhatsApp: EstadoAgenteWhatsApp = {
    fase: 'inactivo',
    prospectoActual: undefined,
    enviadosHoy: 0,
    enviadosEnSesion: 0,
    topeDiario: 60,
    tiempoSiguienteSegundos: 0,
    mensaje: 'Agente 2 en espera.',
  };

  constructor(
    private readonly scraperService: ScraperService,
    private readonly whatsappService: WhatsappService,
  ) {}

  /**
   * Retorna el estado en tiempo real de los 2 agentes y de la cola compartida.
   */
  async obtenerEstado(): Promise<EstadoAutopiloto> {
    const enviadosHoy = await this.whatsappService.contarEnviadosHoy();
    const topeDiario = this.whatsappService.getTopeDiario();
    this.estadoAgenteWhatsApp.enviadosHoy = enviadosHoy;
    this.estadoAgenteWhatsApp.topeDiario = topeDiario;

    return {
      activo: this.activo,
      pausado: this.pausado,
      faseGlobal: this.faseGlobal,
      mensajeEstado: this.mensajeEstado,
      agenteScraper: { ...this.estadoAgenteScraper },
      agenteWhatsApp: { ...this.estadoAgenteWhatsApp },
      colaPendientes: this.colaProspectos.length,
      historialTemas: [...this.historialTemas],
    };
  }

  /**
   * Inicia los 2 agentes en bucle concurrente cooperativo.
   */
  async iniciar(dto: IniciarAutopilotoDto): Promise<{ exito: boolean; mensaje: string }> {
    if (!this.whatsappService.isConectado()) {
      return {
        exito: false,
        mensaje: 'Primero debes conectar WhatsApp Web y escanear el QR antes de iniciar el Auto-Piloto.',
      };
    }

    if (this.activo) {
      return {
        exito: false,
        mensaje: 'El Auto-Piloto con 2 agentes ya se encuentra en ejecución.',
      };
    }

    // Filtrar temas válidos
    const temasLimpios = (dto.temas || [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (temasLimpios.length === 0) {
      return {
        exito: false,
        mensaje: 'Debes proporcionar al menos un tema o búsqueda para prospectar.',
      };
    }

    const enviadosHoy = await this.whatsappService.contarEnviadosHoy();
    const topeDiario = this.whatsappService.getTopeDiario();
    if (enviadosHoy >= topeDiario) {
      return {
        exito: false,
        mensaje: `Ya se alcanzó el tope diario de ${topeDiario} mensajes hoy. Espera hasta mañana por seguridad.`,
      };
    }

    // Inicializar estado del sistema cooperativo
    this.activo = true;
    this.pausado = false;
    this.detenerSolicitado = false;
    this.scraperCompletado = false;
    this.faseGlobal = 'ejecutando';
    this.colaProspectos = [];
    this.telefonosEncolados = new Set();
    this.historialTemas = [];

    this.estadoAgenteScraper = {
      fase: 'escrapeando',
      temaActual: temasLimpios[0] || '',
      indiceTemaActual: 1,
      totalTemas: temasLimpios.length,
      prospectosEncontradosTotal: 0,
      prospectosEncoladosTotal: 0,
      tiempoRestantePausaSegundos: 0,
      mensaje: `Iniciando Agente 1 (Scraper) para ${temasLimpios.length} temas...`,
    };

    this.estadoAgenteWhatsApp = {
      fase: 'esperando_cola',
      prospectoActual: undefined,
      enviadosHoy,
      enviadosEnSesion: 0,
      topeDiario,
      tiempoSiguienteSegundos: 0,
      mensaje: 'Iniciando Agente 2 (WhatsApp)... Esperando primeros prospectos en cola.',
    };

    this.mensajeEstado = `Auto-Piloto de 2 agentes activo: Agente 1 (Scraper) y Agente 2 (WhatsApp) operando en loop concurrente.`;

    // Lanzar ambos agentes en bucles asíncronos concurrentes
    Promise.all([
      this.ejecutarLoopAgenteScraper(temasLimpios, dto),
      this.ejecutarLoopAgenteWhatsApp(dto),
    ])
      .catch((err) => {
        this.logger.error(`Error en pipeline de 2 agentes: ${(err as Error).message}`);
        this.faseGlobal = 'error';
        this.mensajeEstado = `Error inesperado: ${(err as Error).message}`;
      })
      .finally(async () => {
        this.activo = false;
        if (!this.detenerSolicitado) {
          this.faseGlobal = 'completado';
          const totalFinal = await this.whatsappService.contarEnviadosHoy();
          this.mensajeEstado = `Auto-Piloto finalizado exitosamente. Total enviados hoy: ${totalFinal}/${topeDiario}.`;
          this.logger.log(this.mensajeEstado);
        }
      });

    return {
      exito: true,
      mensaje: `Auto-Piloto de 2 agentes iniciado: Agente 1 (Scraper) y Agente 2 (WhatsApp) operando en paralelo con cola compartida.`,
    };
  }

  /**
   * Pausa ambos agentes.
   */
  pausar(): { exito: boolean; mensaje: string } {
    if (!this.activo) {
      return { exito: false, mensaje: 'El Auto-Piloto no está activo.' };
    }
    this.pausado = true;
    this.faseGlobal = 'pausado';
    this.estadoAgenteScraper.fase = 'pausado';
    this.estadoAgenteWhatsApp.fase = 'pausado';
    this.mensajeEstado = 'Auto-Piloto pausado (ambos agentes en pausa).';
    return { exito: true, mensaje: 'Auto-Piloto pausado.' };
  }

  /**
   * Reanuda ambos agentes.
   */
  reanudar(): { exito: boolean; mensaje: string } {
    if (!this.activo) {
      return { exito: false, mensaje: 'El Auto-Piloto no está activo.' };
    }
    this.pausado = false;
    this.faseGlobal = 'ejecutando';
    this.mensajeEstado = 'Auto-Piloto reanudado.';
    return { exito: true, mensaje: 'Auto-Piloto reanudado.' };
  }

  /**
   * Detiene de inmediato ambos agentes y limpia la cola.
   */
  detener(): { exito: boolean; mensaje: string } {
    if (!this.activo) {
      return { exito: false, mensaje: 'El Auto-Piloto no está activo.' };
    }
    this.detenerSolicitado = true;
    this.pausado = false;
    this.activo = false;
    this.faseGlobal = 'inactivo';
    this.estadoAgenteScraper.fase = 'inactivo';
    this.estadoAgenteWhatsApp.fase = 'inactivo';
    this.estadoAgenteScraper.tiempoRestantePausaSegundos = 0;
    this.estadoAgenteWhatsApp.tiempoSiguienteSegundos = 0;
    this.colaProspectos = [];
    this.mensajeEstado = 'Auto-Piloto detenido por el usuario.';
    return { exito: true, mensaje: 'Auto-Piloto detenido.' };
  }

  /**
   * BUCLE DEL AGENTE 1: Explorador / Scraper de Google Maps
   * Recorre la lista de temas, extrae prospectos PyME, filtra y abastece la cola compartida.
   * Realiza pausas de 5 minutos entre temas para evitar saturar Google Maps.
   */
  private async ejecutarLoopAgenteScraper(temas: string[], dto: IniciarAutopilotoDto) {
    const limitePorTema = dto.limitePorTema || 20;
    const pausaMinutos = dto.pausaMinutosEntreTemas !== undefined ? dto.pausaMinutosEntreTemas : 5;
    const pausaSegundosTotal = Math.max(pausaMinutos, 1) * 60;
    const topeDiario = this.whatsappService.getTopeDiario();

    this.logger.log(`[Agente 1 - Scraper] Iniciando loop para ${temas.length} temas.`);

    for (let i = 0; i < temas.length; i++) {
      if (this.detenerSolicitado) break;

      const totalHoy = await this.whatsappService.contarEnviadosHoy();
      if (totalHoy >= topeDiario) {
        this.estadoAgenteScraper.fase = 'completado';
        this.estadoAgenteScraper.mensaje = `Tope diario de ${topeDiario} mensajes alcanzado. Scraper finalizado.`;
        break;
      }

      // Control de pausa
      while (this.pausado && !this.detenerSolicitado) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (this.detenerSolicitado) break;

      const tema = temas[i];
      this.estadoAgenteScraper.fase = 'escrapeando';
      this.estadoAgenteScraper.temaActual = tema;
      this.estadoAgenteScraper.indiceTemaActual = i + 1;
      this.estadoAgenteScraper.mensaje = `🔍 [Tema ${i + 1}/${temas.length}] Escrapeando Google Maps para: "${tema}"...`;
      this.logger.log(`[Agente 1 - Scraper] Escrapeando "${tema}"...`);

      let encontrados: ProspectoDto[] = [];
      try {
        const resultadoScraping = await this.scraperService.buscarProspectos(tema, limitePorTema, {
          soloConWhatsapp: dto.soloConWhatsapp !== false,
          excluirGrandesCadenas: dto.excluirGrandesCadenas !== false,
          maxResenas: dto.maxResenas !== undefined ? dto.maxResenas : 20,
          soloNuevosOPequenos: dto.soloNuevosOPequenos !== false,
          soloDel2026: dto.soloDel2026 !== false,
        });
        encontrados = resultadoScraping.prospectos;
      } catch (err) {
        this.logger.warn(`[Agente 1 - Scraper] Error en tema "${tema}": ${(err as Error).message}`);
      }

      this.estadoAgenteScraper.prospectosEncontradosTotal += encontrados.length;

      // Filtrar contra historial persistido y contra teléfonos ya encolados
      const telefonosContactadosSet = await this.whatsappService.obtenerSetContactados();

      const nuevosParaEncolar: ProspectoDto[] = [];
      for (const p of encontrados) {
        if (!p.telefono || !p.whatsappUrl) continue;
        const { digitos, ultimos9, canonico } = WhatsappService.normalizarTelefono(p.telefono);
        const yaContactado =
          telefonosContactadosSet.has(digitos) ||
          telefonosContactadosSet.has(ultimos9) ||
          telefonosContactadosSet.has(canonico);
        const yaEncolado =
          this.telefonosEncolados.has(digitos) ||
          this.telefonosEncolados.has(ultimos9) ||
          this.telefonosEncolados.has(canonico);

        if (!yaContactado && !yaEncolado) {
          if (digitos) this.telefonosEncolados.add(digitos);
          if (ultimos9) this.telefonosEncolados.add(ultimos9);
          if (canonico) this.telefonosEncolados.add(canonico);
          nuevosParaEncolar.push(p);
        }
      }

      // Depositar prospectos en la cola compartida para el Agente 2
      this.colaProspectos.push(...nuevosParaEncolar);
      this.estadoAgenteScraper.prospectosEncoladosTotal += nuevosParaEncolar.length;

      this.historialTemas.push({
        tema,
        encontrados: encontrados.length,
        nuevos: nuevosParaEncolar.length,
        enviados: 0,
        fecha: new Date().toISOString(),
      });

      this.logger.log(
        `[Agente 1 - Scraper] "${tema}": ${encontrados.length} encontrados, ${nuevosParaEncolar.length} encolados. Cola compartida: ${this.colaProspectos.length} prospectos en espera.`,
      );

      // Si quedan más temas y aún no se alcanza la meta de 60, realizar la pausa de enfriamiento de 5 min
      const enviadosCheck = await this.whatsappService.contarEnviadosHoy();
      const hayMasTemas = i + 1 < temas.length;

      if (hayMasTemas && enviadosCheck < topeDiario && !this.detenerSolicitado) {
        this.estadoAgenteScraper.fase = 'pausa_enfriamiento';
        const siguienteTema = temas[i + 1];

        this.logger.log(
          `[Agente 1 - Scraper] Tema "${tema}" listo. Pausa de ${pausaMinutos} min antes de raspar "${siguienteTema}"...`,
        );

        for (let s = pausaSegundosTotal; s > 0; s--) {
          if (this.detenerSolicitado) break;

          const hoyTotal = await this.whatsappService.contarEnviadosHoy();
          if (hoyTotal >= topeDiario) break;

          while (this.pausado && !this.detenerSolicitado) {
            await new Promise((r) => setTimeout(r, 1000));
          }

          this.estadoAgenteScraper.tiempoRestantePausaSegundos = s;
          const mins = Math.floor(s / 60);
          const segs = s % 60;
          const fmt = `${mins.toString().padStart(2, '0')}:${segs.toString().padStart(2, '0')}`;
          this.estadoAgenteScraper.mensaje = `⏳ Enfriamiento Maps: esperando ${fmt} antes de "${siguienteTema}" (Cola: ${this.colaProspectos.length})...`;
          await new Promise((r) => setTimeout(r, 1000));
        }

        this.estadoAgenteScraper.tiempoRestantePausaSegundos = 0;
      }
    }

    this.estadoAgenteScraper.fase = 'completado';
    this.estadoAgenteScraper.mensaje = `Búsquedas concluidas (${this.estadoAgenteScraper.prospectosEncoladosTotal} prospectos aportados a la cola).`;
    this.scraperCompletado = true;
    this.logger.log(`[Agente 1 - Scraper] Loop finalizado exitosamente.`);
  }

  /**
   * BUCLE DEL AGENTE 2: Despachador / Mensajero de WhatsApp
   * Consume la cola compartida en tiempo real, despachando mensajes a ritmo humano (20s-45s)
   * y deteniéndose automáticamente cuando se alcanza el tope diario de 60.
   */
  private async ejecutarLoopAgenteWhatsApp(dto: IniciarAutopilotoDto) {
    const topeDiario = this.whatsappService.getTopeDiario();

    this.logger.log(`[Agente 2 - WhatsApp] Iniciando loop de despacho con tope de ${topeDiario}.`);

    while (!this.detenerSolicitado) {
      const enviadosHoy = await this.whatsappService.contarEnviadosHoy();
      this.estadoAgenteWhatsApp.enviadosHoy = enviadosHoy;

      if (enviadosHoy >= topeDiario) {
        this.estadoAgenteWhatsApp.fase = 'completado';
        this.estadoAgenteWhatsApp.mensaje = `Tope seguro de ${topeDiario} mensajes diarios alcanzado.`;
        this.detenerSolicitado = true; // Detiene también al Agente 1
        break;
      }

      // Control de pausa
      while (this.pausado && !this.detenerSolicitado) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (this.detenerSolicitado) break;

      // Si hay prospectos en la cola compartida:
      if (this.colaProspectos.length > 0) {
        const prospecto = this.colaProspectos.shift()!;
        this.estadoAgenteWhatsApp.fase = 'enviando';
        this.estadoAgenteWhatsApp.prospectoActual = prospecto.nombre;
        this.estadoAgenteWhatsApp.mensaje = `💬 Enviando mensaje a "${prospecto.nombre}" (${prospecto.telefono})...`;
        this.logger.log(
          `[Agente 2 - WhatsApp] Procesando envío a: ${prospecto.nombre} (${prospecto.telefono}). Cola restante: ${this.colaProspectos.length}`,
        );

        const exito = await this.whatsappService.enviarMensajeProspecto(prospecto, {
          plantillas: dto.plantillas,
          mensajePersonalizado: dto.mensajePersonalizado,
          archivosAdjuntosPaths: dto.archivosAdjuntosPaths,
          tipoAdjunto: dto.tipoAdjunto,
        });

        if (exito) {
          this.estadoAgenteWhatsApp.enviadosEnSesion++;
          const nuevosEnviados = await this.whatsappService.contarEnviadosHoy();
          this.estadoAgenteWhatsApp.enviadosHoy = nuevosEnviados;
          this.logger.log(
            `[Agente 2 - WhatsApp] Enviado exitoso a ${prospecto.nombre} [${nuevosEnviados}/${topeDiario}].`,
          );

          if (nuevosEnviados >= topeDiario) {
            this.estadoAgenteWhatsApp.fase = 'completado';
            this.estadoAgenteWhatsApp.mensaje = `Tope diario de ${topeDiario} alcanzado.`;
            this.detenerSolicitado = true;
            break;
          }
        }

        // Pausa humana anti-baneo aleatoria (20s a 45s) si aún no se termina
        const checkTotal = await this.whatsappService.contarEnviadosHoy();
        const debeEsperar =
          checkTotal < topeDiario &&
          !this.detenerSolicitado &&
          (this.colaProspectos.length > 0 || !this.scraperCompletado);

        if (debeEsperar) {
          this.estadoAgenteWhatsApp.fase = 'pausa_humana';
          const esperaSegundos = Math.floor(20 + Math.random() * 25);
          this.estadoAgenteWhatsApp.tiempoSiguienteSegundos = esperaSegundos;

          for (let s = esperaSegundos; s > 0; s--) {
            if (this.detenerSolicitado) break;
            while (this.pausado && !this.detenerSolicitado) {
              await new Promise((r) => setTimeout(r, 1000));
            }
            this.estadoAgenteWhatsApp.tiempoSiguienteSegundos = s;
            this.estadoAgenteWhatsApp.mensaje = `⏳ Pausa humana anti-baneo: esperando ${s}s antes del siguiente envío (Cola: ${this.colaProspectos.length})...`;
            await new Promise((r) => setTimeout(r, 1000));
          }
          this.estadoAgenteWhatsApp.tiempoSiguienteSegundos = 0;
        }
      } else {
        // La cola está vacía
        if (!this.scraperCompletado) {
          // El Agente 1 sigue buscando o en su pausa de 5 min: esperamos a que deposite más prospectos
          this.estadoAgenteWhatsApp.fase = 'esperando_cola';
          this.estadoAgenteWhatsApp.prospectoActual = undefined;
          this.estadoAgenteWhatsApp.mensaje = `💤 Esperando que el Agente 1 (Scraper) agregue nuevos comercios a la cola...`;
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          // Cola vacía y el Agente 1 ya terminó todos los temas
          this.estadoAgenteWhatsApp.fase = 'completado';
          this.estadoAgenteWhatsApp.mensaje = `Cola vacía y todos los temas procesados. Despacho finalizado.`;
          break;
        }
      }
    }

    this.estadoAgenteWhatsApp.prospectoActual = undefined;
    this.estadoAgenteWhatsApp.tiempoSiguienteSegundos = 0;
    this.logger.log(`[Agente 2 - WhatsApp] Loop finalizado exitosamente.`);
  }
}
