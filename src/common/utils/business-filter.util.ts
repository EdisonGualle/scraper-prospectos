import {
  GRANDES_CADENAS_ECUADOR,
  PALABRAS_CLAVE_EXCLUSION,
} from '../constants/grandes-cadenas';

export class BusinessFilterUtil {
  /**
   * Normaliza texto para comparación limpia (sin tildes, minúsculas).
   */
  static normalizarTexto(texto: string): string {
    return (texto || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  /**
   * Determina si el negocio es un Pequeño o Nuevo Negocio (2026, máximo 20 reseñas)
   * ideal para venderle facturación, descartando:
   * 1. Cadenas grandes / corporativas (Tía, Supermaxi, KFC, etc.)
   * 2. Negocios antiguos con reseñas de años previos (hace 2 años, 3 años, etc.)
   * 3. Negocios con más de 20 reseñas (ya consolidados).
   */
  static evaluarProspecto(
    nombre: string,
    categoria?: string,
    totalResenas?: number,
    lineasTexto: string[] = [],
    sitioWeb?: string,
    maxResenas: number = 20,
    soloNuevosOPequenos: boolean = true,
    soloDel2026: boolean = true,
    fechasResenas: string[] = [],
  ): {
    esCandidatoValido: boolean;
    motivoDescarte?: string;
    esNuevo: boolean;
    oportunidad: '🔥 ALTA (Nuevo 2026 - Sin Facturador)' | 'MEDIA (PyME Joven)' | 'ESTABLECIDO';
  } {
    const nombreNorm = this.normalizarTexto(nombre);
    const catNorm = this.normalizarTexto(categoria || '');
    const textoUnido = lineasTexto.map((l) => this.normalizarTexto(l)).join(' ');

    // Detectar si es nuevo local en Google Maps ("Nuevo" o "Abierto recientemente")
    const esNuevo =
      textoUnido.includes('nuevo') ||
      textoUnido.includes('abierto recientemente') ||
      totalResenas === undefined ||
      totalResenas === 0;

    // 1. Comprobar contra la lista negra de grandes cadenas en Ecuador
    for (const cadena of GRANDES_CADENAS_ECUADOR) {
      const cadenaNorm = this.normalizarTexto(cadena);
      const regex = new RegExp(`(^|\\b|\\s)${cadenaNorm}(\\b|\\s|$)`, 'i');
      if (regex.test(nombreNorm)) {
        return {
          esCandidatoValido: false,
          motivoDescarte: `Gran cadena / Corporación: "${cadena}" (ya tienen ERP/facturador corporativo)`,
          esNuevo: false,
          oportunidad: 'ESTABLECIDO',
        };
      }
    }

    // 2. Palabras clave de exclusión corporativa
    for (const palabra of PALABRAS_CLAVE_EXCLUSION) {
      if (nombreNorm.includes(palabra) || catNorm.includes(palabra)) {
        return {
          esCandidatoValido: false,
          motivoDescarte: `Término corporativo detectado: "${palabra}"`,
          esNuevo: false,
          oportunidad: 'ESTABLECIDO',
        };
      }
    }

    // 3. Filtro de Madurez estricto: máximo 20 reseñas (para asegurar que sea nuevo / pequeño)
    if (soloNuevosOPequenos && totalResenas && totalResenas > maxResenas) {
      return {
        esCandidatoValido: false,
        motivoDescarte: `Tiene ${totalResenas} reseñas (supera el límite de ${maxResenas}) - Ya consolidado con probable facturador`,
        esNuevo: false,
        oportunidad: 'ESTABLECIDO',
      };
    }

    // 4. Filtro de Antigüedad (Solo locales de 2026 / recientes)
    if (soloDel2026 && fechasResenas && fechasResenas.length > 0) {
      for (const fecha of fechasResenas) {
        const fNorm = this.normalizarTexto(fecha);
        // Si tiene reseñas de hace 2 o más años, o años explícitos pasados, no es del 2026
        if (
          fNorm.includes('ano') ||
          fNorm.includes('año') ||
          /\b(201\d|202[0-5])\b/.test(fNorm)
        ) {
          return {
            esCandidatoValido: false,
            motivoDescarte: `Local antiguo con actividad de años previos (${fecha}) - No es del 2026`,
            esNuevo: false,
            oportunidad: 'ESTABLECIDO',
          };
        }
      }
    }

    // 5. Nivel de Oportunidad de Venta
    const tieneSitioWeb =
      !!sitioWeb &&
      !sitioWeb.includes('facebook.com') &&
      !sitioWeb.includes('instagram.com');

    let oportunidad:
      | '🔥 ALTA (Nuevo 2026 - Sin Facturador)'
      | 'MEDIA (PyME Joven)'
      | 'ESTABLECIDO' = 'MEDIA (PyME Joven)';

    if (
      esNuevo ||
      (totalResenas !== undefined && totalResenas <= 15 && !tieneSitioWeb)
    ) {
      oportunidad = '🔥 ALTA (Nuevo 2026 - Sin Facturador)';
    }

    return {
      esCandidatoValido: true,
      esNuevo,
      oportunidad,
    };
  }
}
