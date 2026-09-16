import {
  Controller,
  Get,
  Post,
  Body,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import { WhatsappService } from './whatsapp.service';
import { ProspectoDto } from '../scraper/dto/prospecto.dto';

const storageConfig = diskStorage({
  destination: './uploads',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9]/g, '_')
      .slice(0, 25);
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

import { IsString, IsNotEmpty, IsOptional, IsArray, IsIn } from 'class-validator';

export class EnviarPruebaDto {
  @IsString()
  @IsNotEmpty()
  telefono!: string;

  @IsOptional()
  @IsString()
  mensaje?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  archivosAdjuntosPaths?: string[];

  @IsOptional()
  @IsIn(['foto', 'documento'])
  tipoAdjunto?: 'foto' | 'documento';
}

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
   * Sube múltiples archivos adjuntos (imágenes, flyers, PDFs) para la campaña.
   */
  @Post('subir-adjuntos')
  @UseInterceptors(FilesInterceptor('archivos', 10, { storage: storageConfig }))
  subirAdjuntos(@UploadedFiles() files?: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se ha recibido ningún archivo.');
    }
    return {
      exito: true,
      archivos: files.map((f) => ({
        nombreOriginal: f.originalname,
        nombreArchivo: f.filename,
        rutaArchivo: path.resolve(f.path),
        tamano: f.size,
      })),
    };
  }

  /**
   * Sube un solo archivo adjunto (retrocompatibilidad).
   */
  @Post('subir-adjunto')
  @UseInterceptors(FileInterceptor('archivo', { storage: storageConfig }))
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
    @Body('archivosAdjuntosPaths') archivosAdjuntosPaths?: string[],
    @Body('archivoAdjuntoPath') archivoAdjuntoPath?: string,
    @Body('tipoAdjunto') tipoAdjunto?: 'foto' | 'documento',
  ) {
    if (!prospectos || !Array.isArray(prospectos) || prospectos.length === 0) {
      return { exito: false, mensaje: 'Debes enviar una lista válida de prospectos.' };
    }
    return this.whatsappService.iniciarCampana(prospectos, {
      plantillas,
      mensajePersonalizado,
      archivosAdjuntosPaths,
      archivoAdjuntoPath,
      tipoAdjunto,
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

  @Post('importar-contactados')
  async importarContactados(@Body('telefonos') telefonos: string[]) {
    if (!telefonos || !Array.isArray(telefonos) || telefonos.length === 0) {
      throw new BadRequestException('Debes enviar una lista de números telefónicos.');
    }
    return this.whatsappService.importarContactados(telefonos);
  }

  @Post('enviar-prueba')
  async enviarPrueba(@Body() dto: EnviarPruebaDto) {
    return this.whatsappService.enviarMensajePrueba(dto.telefono, {
      mensaje: dto.mensaje,
      archivosAdjuntosPaths: dto.archivosAdjuntosPaths,
      tipoAdjunto: dto.tipoAdjunto,
    });
  }

  @Get('debug-adjuntos')
  async debugAdjuntos(@Query('telefono') telefono?: string) {
    return this.whatsappService.debugAdjuntos(telefono);
  }
}
