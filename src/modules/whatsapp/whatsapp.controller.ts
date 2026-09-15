import {
  Controller,
  Get,
  Post,
  Body,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import { WhatsappService } from './whatsapp.service';
import { ProspectoDto } from '../scraper/dto/prospecto.dto';

@Controller('api/whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get('estado')
  async obtenerEstado() {
    return this.whatsappService.obtenerEstado();
  }

  @Post('conectar')
  async conectar() {
    return this.whatsappService.conectar();
  }

  /**
   * Sube un archivo adjunto (PDF, imagen) para la campaña comercial.
   */
  @Post('subir-adjunto')
  @UseInterceptors(
    FileInterceptor('archivo', {
      storage: diskStorage({
        destination: './uploads',
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname);
          const base = path
            .basename(file.originalname, ext)
            .replace(/[^a-zA-Z0-9]/g, '_')
            .slice(0, 25);
          cb(null, `${Date.now()}_${base}${ext}`);
        },
      }),
    }),
  )
  subirAdjunto(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No se ha recibido ningún archivo.');
    }
    return {
      exito: true,
      nombreOriginal: file.originalname,
      nombreArchivo: file.filename,
      rutaArchivo: path.resolve(file.path),
      tamano: file.size,
    };
  }

  @Post('iniciar')
  async iniciar(
    @Body('prospectos') prospectos: ProspectoDto[],
    @Body('plantillas') plantillas?: string[],
    @Body('mensajePersonalizado') mensajePersonalizado?: string,
    @Body('archivoAdjuntoPath') archivoAdjuntoPath?: string,
  ) {
    if (!prospectos || !Array.isArray(prospectos) || prospectos.length === 0) {
      return { exito: false, mensaje: 'Debes enviar una lista válida de prospectos.' };
    }
    return this.whatsappService.iniciarCampana(prospectos, {
      plantillas,
      mensajePersonalizado,
      archivoAdjuntoPath,
    });
  }

  @Post('pausar')
  pausar() {
    return this.whatsappService.pausarCampana();
  }

  @Get('historial')
  async obtenerHistorial() {
    return this.whatsappService.obtenerHistorial();
  }
}
