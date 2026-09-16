import { IsArray, IsString, IsOptional, IsInt, Min, Max, IsBoolean, IsIn } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class IniciarAutopilotoDto {
  @IsArray()
  @IsString({ each: true })
  temas!: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limitePorTema?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  pausaMinutosEntreTemas?: number = 5;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  soloConWhatsapp?: boolean = true;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  excluirGrandesCadenas?: boolean = true;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxResenas?: number = 20;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  soloNuevosOPequenos?: boolean = true;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  soloDel2026?: boolean = true;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  plantillas?: string[];

  @IsOptional()
  @IsString()
  mensajePersonalizado?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  archivosAdjuntosPaths?: string[];

  @IsOptional()
  @IsIn(['foto', 'documento'])
  tipoAdjunto?: 'foto' | 'documento' = 'foto';
}
