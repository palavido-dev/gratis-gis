// SPDX-License-Identifier: AGPL-3.0-or-later
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Real DTO classes for analysis POST bodies (#225). Interfaces are
 * erased at runtime, so ValidationPipe skipped them entirely —
 * `whitelist` / `forbidNonWhitelisted` never ran and typos reached
 * hand-rolled checks downstream. Decorators make the surface honest.
 */

export class HillshadeBodyDto {
  @IsIn(['dtm', 'dsm'])
  mode!: 'dtm' | 'dsm';

  @Type(() => Number)
  @IsNumber()
  @Min(0.25)
  @Max(50)
  resolution!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(360)
  azimuth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(90)
  altitude?: number;
}

export class ResolutionBodyDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.25)
  @Max(50)
  resolution!: number;
}

export class ViewshedBodyDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(100)
  heightM?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(100)
  @Max(20000)
  maxDistanceM?: number;
}

export class ContoursBodyDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(500)
  intervalM?: number;
}

const ZONAL_STATS = ['mean', 'min', 'max', 'sum', 'count'] as const;
export type ZonalStatName = (typeof ZONAL_STATS)[number];

/**
 * Zonal statistics: summarize a raster inside polygon zones
 * from a data_layer. Source item on the route is the raster
 * (tile_layer with a COG); zones come from zoneItemId.
 */
export class ZonalStatsBodyDto {
  @IsUUID()
  zoneItemId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  zoneLayerKey?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(16)
  band?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn([...ZONAL_STATS], { each: true })
  stats?: ZonalStatName[];
}
