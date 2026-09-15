import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class BuscarProspectosDto {
  @IsString()
  @IsNotEmpty()
  query: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limite?: number = 30;

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
}
