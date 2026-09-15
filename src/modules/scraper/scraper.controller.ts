import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { ScraperService } from './scraper.service';
import { ExcelService } from '../excel/excel.service';
import { BuscarProspectosDto } from './dto/buscar-prospectos.dto';

@Controller('api/leads')
export class ScraperController {
  constructor(
    private readonly scraperService: ScraperService,
    private readonly excelService: ExcelService,
  ) {}

  /**
   * Endpoint POST para buscar prospectos y obtener la lista en JSON.
   */
  @Post('buscar')
  async buscar(@Body() dto: BuscarProspectosDto) {
    if (!dto.query || dto.query.trim().length === 0) {
      throw new BadRequestException('El parámetro query es obligatorio.');
    }

    const { prospectos, metricas } = await this.scraperService.buscarProspectos(
      dto.query,
      dto.limite || 30,
      {
        soloConWhatsapp: dto.soloConWhatsapp !== false,
        excluirGrandesCadenas: dto.excluirGrandesCadenas !== false,
        maxResenas: dto.maxResenas !== undefined ? dto.maxResenas : 20,
        soloNuevosOPequenos: dto.soloNuevosOPequenos !== false,
        soloDel2026: dto.soloDel2026 !== false,
      },
    );

    return {
      exito: true,
      termino: dto.query,
      total: prospectos.length,
      contactablesWhatsApp: prospectos.filter((p) => p.whatsappUrl).length,
      metricas,
      data: prospectos,
    };
  }

  /**
   * Endpoint GET para descargar directamente el reporte en Excel (.xlsx).
   * Ejemplo: GET /api/leads/descargar-excel?query=ferreterias+quito&limite=30
   */
  @Get('descargar-excel')
  async descargarExcel(
    @Query('query') query: string,
    @Query('limite') limite: string,
    @Query('soloConWhatsapp') soloConWhatsapp: string,
    @Query('excluirGrandesCadenas') excluirGrandesCadenas: string,
    @Query('maxResenas') maxResenas: string,
    @Query('soloNuevosOPequenos') soloNuevosOPequenos: string,
    @Query('soloDel2026') soloDel2026: string,
    @Res() res: Response,
  ) {
    if (!query || query.trim().length === 0) {
      throw new BadRequestException('El parámetro query es obligatorio.');
    }

    const limiteNum = limite ? parseInt(limite, 10) : 30;
    const maxResenasNum = maxResenas ? parseInt(maxResenas, 10) : 20;
    const { prospectos } = await this.scraperService.buscarProspectos(
      query,
      limiteNum,
      {
        soloConWhatsapp: soloConWhatsapp !== 'false',
        excluirGrandesCadenas: excluirGrandesCadenas !== 'false',
        maxResenas: maxResenasNum,
        soloNuevosOPequenos: soloNuevosOPequenos !== 'false',
        soloDel2026: soloDel2026 !== 'false',
      },
    );

    const buffer = await this.excelService.generarReporteBuffer(
      prospectos,
      query,
    );

    const nombreLimpio = query.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const fecha = new Date().toISOString().slice(0, 10);
    const fileName = `prospectos_${nombreLimpio}_${fecha}.xlsx`;

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }

  /**
   * Endpoint GET para guardar el reporte en la carpeta de servidor /reportes.
   */
  @Get('guardar-local')
  async guardarLocal(
    @Query('query') query: string,
    @Query('limite') limite: string,
    @Query('soloConWhatsapp') soloConWhatsapp: string,
    @Query('excluirGrandesCadenas') excluirGrandesCadenas: string,
  ) {
    if (!query) {
      throw new BadRequestException('El parámetro query es obligatorio.');
    }

    const limiteNum = limite ? parseInt(limite, 10) : 30;
    const { prospectos, metricas } = await this.scraperService.buscarProspectos(
      query,
      limiteNum,
      {
        soloConWhatsapp: soloConWhatsapp !== 'false',
        excluirGrandesCadenas: excluirGrandesCadenas !== 'false',
      },
    );
    const archivoRuta = await this.excelService.guardarReporteEnDisco(
      prospectos,
      query,
    );

    return {
      exito: true,
      termino: query,
      total: prospectos.length,
      metricas,
      archivoGenerado: archivoRuta,
    };
  }
}
