/**
 * Utilidades para normalizar números telefónicos y generar enlaces a WhatsApp en Ecuador.
 */
export class PhoneUtil {
  /**
   * Limpia y normaliza un número telefónico de Ecuador.
   */
  static normalizarTelefono(rawPhone: string | null | undefined): {
    telefonoFormateado: string;
    esCelular: boolean;
    whatsappUrl: string | null;
  } {
    if (!rawPhone) {
      return { telefonoFormateado: '', esCelular: false, whatsappUrl: null };
    }

    // Quitar caracteres no numéricos excepto el signo +
    const soloNumeros = rawPhone.replace(/\D/g, '');

    let numeroEcuador = '';
    let esCelular = false;

    // Caso: Viene con código internacional 593 (ej. 593991234567)
    if (soloNumeros.startsWith('593')) {
      const resto = soloNumeros.substring(3);
      if (resto.startsWith('9') && resto.length === 9) {
        numeroEcuador = `593${resto}`;
        esCelular = true;
      } else {
        numeroEcuador = soloNumeros;
      }
    }
    // Caso: Viene en formato local ecuatoriano (ej. 0991234567)
    else if (soloNumeros.startsWith('09') && soloNumeros.length === 10) {
      numeroEcuador = `593${soloNumeros.substring(1)}`;
      esCelular = true;
    }
    // Caso: Celular sin cero inicial (ej. 991234567)
    else if (soloNumeros.startsWith('9') && soloNumeros.length === 9) {
      numeroEcuador = `593${soloNumeros}`;
      esCelular = true;
    }
    // Caso: Teléfono fijo (ej. 022345678)
    else if (soloNumeros.startsWith('0') && soloNumeros.length === 9) {
      numeroEcuador = `593${soloNumeros.substring(1)}`;
      esCelular = false;
    } else {
      numeroEcuador = soloNumeros;
    }

    const whatsappUrl = esCelular ? `https://wa.me/${numeroEcuador}` : null;

    return {
      telefonoFormateado: rawPhone.trim(),
      esCelular,
      whatsappUrl,
    };
  }
}
