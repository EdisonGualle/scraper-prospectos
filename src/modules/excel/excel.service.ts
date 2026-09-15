import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { ProspectoDto } from '../scraper/dto/prospecto.dto';

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  /**
   * Genera el libro Excel profesional en memoria como Buffer.
   */
  async generarReporteBuffer(prospectos: ProspectoDto[], tituloBusqueda: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Necios Scraper B2B';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Prospectos Facturación', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: 'FF2563EB' } },
    });

    // Definición de columnas
    sheet.columns = [
      { header: 'Negocio / Razón Comercial', key: 'nombre', width: 35 },
      { header: 'Oportunidad Facturación', key: 'oportunidad', width: 26 },
      { header: '¿Local Nuevo?', key: 'esNuevo', width: 16 },
      { header: 'Categoría / Rubro', key: 'categoria', width: 25 },
      { header: 'Teléfono', key: 'telefono', width: 18 },
      { header: 'Contacto WhatsApp', key: 'whatsapp', width: 26 },
      { header: 'Sitio Web', key: 'sitioWeb', width: 30 },
      { header: 'Dirección', key: 'direccion', width: 40 },
      { header: 'Calificación', key: 'calificacion', width: 14 },
      { header: 'Reseñas', key: 'totalResenas', width: 12 },
      { header: 'Enlace Google Maps', key: 'mapsUrl', width: 22 },
      { header: 'Término de Búsqueda', key: 'termino', width: 25 },
    ];

    // Estilo de cabecera
    const headerRow = sheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' }, // Azul pizarra oscuro
      };
      cell.font = {
        name: 'Segoe UI',
        size: 11,
        bold: true,
        color: { argb: 'FFFFFFFF' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        bottom: { style: 'medium', color: { argb: 'FF0284C7' } },
      };
    });

    // Relleno de datos
    prospectos.forEach((p, index) => {
      const rowIndex = index + 2;
      const row = sheet.addRow({
        nombre: p.nombre,
        oportunidad: p.oportunidad || 'MEDIA',
        esNuevo: p.esNuevo ? '✨ SÍ (NUEVO)' : 'No',
        categoria: p.categoria || 'Comercial',
        telefono: p.telefono || 'No disponible',
        whatsapp: '',
        sitioWeb: p.sitioWeb || '',
        direccion: p.direccion || '',
        calificacion: p.calificacion || '',
        totalResenas: p.totalResenas || 0,
        mapsUrl: '',
        termino: p.terminoBusqueda,
      });

      row.height = 22;

      // Estilo de fila intercalada (zebra)
      const bgColor = rowIndex % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC';
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: 'Segoe UI', size: 10 };
        cell.alignment = { vertical: 'middle' };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bgColor },
        };
        cell.border = {
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        };
      });

      // Estilo para Oportunidad de Venta
      const cellOportunidad = row.getCell('oportunidad');
      if (p.oportunidad?.includes('ALTA')) {
        cellOportunidad.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF047857' } };
        cellOportunidad.alignment = { horizontal: 'center', vertical: 'middle' };
      } else {
        cellOportunidad.alignment = { horizontal: 'center', vertical: 'middle' };
      }

      // Estilo para Local Nuevo
      const cellNuevo = row.getCell('esNuevo');
      if (p.esNuevo) {
        cellNuevo.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF2563EB' } };
      }
      cellNuevo.alignment = { horizontal: 'center', vertical: 'middle' };

      // Celda de WhatsApp con hipervínculo directo
      const cellWa = row.getCell('whatsapp');
      if (p.whatsappUrl) {
        cellWa.value = {
          text: '📲 Escribir por WhatsApp',
          hyperlink: p.whatsappUrl,
          tooltip: `Abrir chat de WhatsApp (${p.telefono})`,
        };
        cellWa.font = {
          name: 'Segoe UI',
          size: 10,
          bold: true,
          color: { argb: 'FF059669' }, // Verde WhatsApp
          underline: true,
        };
        cellWa.alignment = { horizontal: 'center', vertical: 'middle' };
      } else {
        cellWa.value = p.telefono ? 'Solo fijo / No celular' : 'Sin número';
        cellWa.font = { name: 'Segoe UI', size: 9, color: { argb: 'FF94A3B8' } };
        cellWa.alignment = { horizontal: 'center', vertical: 'middle' };
      }

      // Enlace a Sitio Web si existe
      if (p.sitioWeb) {
        const cellWeb = row.getCell('sitioWeb');
        cellWeb.value = {
          text: p.sitioWeb,
          hyperlink: p.sitioWeb,
        };
        cellWeb.font = {
          name: 'Segoe UI',
          size: 9,
          color: { argb: 'FF2563EB' },
          underline: true,
        };
      }

      // Enlace a Google Maps
      if (p.mapsUrl) {
        const cellMaps = row.getCell('mapsUrl');
        cellMaps.value = {
          text: '📍 Ver en Maps',
          hyperlink: p.mapsUrl,
        };
        cellMaps.font = {
          name: 'Segoe UI',
          size: 9,
          color: { argb: 'FF4F46E5' },
          underline: true,
        };
        cellMaps.alignment = { horizontal: 'center', vertical: 'middle' };
      }

      // Alinear números al centro
      row.getCell('calificacion').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('totalResenas').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('telefono').alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Activar autofiltro para toda la tabla
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Guarda el reporte Excel generado en un archivo físico en disco.
   */
  async guardarReporteEnDisco(
    prospectos: ProspectoDto[],
    tituloBusqueda: string,
    outputDir: string = 'reportes',
  ): Promise<string> {
    if (!existsSync(outputDir)) {
      await fs.mkdir(outputDir, { recursive: true });
    }

    const buffer = await this.generarReporteBuffer(prospectos, tituloBusqueda);
    const nombreLimpio = tituloBusqueda
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_');
    const fecha = new Date().toISOString().slice(0, 10);
    const fileName = `prospectos_${nombreLimpio}_${fecha}.xlsx`;
    const filePath = path.join(outputDir, fileName);

    await fs.writeFile(filePath, buffer);
    this.logger.log(`Reporte Excel guardado exitosamente en: ${filePath}`);
    return filePath;
  }
}
