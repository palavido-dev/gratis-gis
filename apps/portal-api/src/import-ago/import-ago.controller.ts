// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { randomBytes } from 'node:crypto';

import { AdminGuard } from '../admin/admin.guard.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

import { AgoDryRunService, type DryRunReport } from './dry-run.js';
import { AgoImportService, type ImportReport } from './import.js';
import {
  AgoImportJobsService,
  type AgoImportJobDto,
} from './jobs.service.js';
import { buildAgoAuthorizeUrl, normalizeAgoUrl } from './ago-url.js';
import {
  AgoConnectionsService,
  type AgoConnectionDto,
} from './connections.service.js';

class AgoPreviewDto {
  @IsString()
  portalUrl!: string;

  @IsString()
  token!: string;

  @IsString()
  @IsOptional()
  username?: string;
}

class AgoRunDto {
  @IsString()
  portalUrl!: string;

  @IsString()
  token!: string;

  @IsObject()
  report!: DryRunReport;
}

class CreateConnectionDto {
  /** AGO org URL in any shape the normalizer accepts. */
  @IsString()
  orgUrl!: string;

  /** Optional human label. Defaults to the org host on the server. */
  @IsString()
  @IsOptional()
  displayName?: string;

  /** AGO OAuth client id (from registering an app on the AGO portal). */
  @IsString()
  clientId!: string;
}

class UpdateConnectionDto {
  @IsString()
  @IsOptional()
  displayName?: string;

  @IsString()
  @IsOptional()
  clientId?: string;
}

class AgoOauthStartDto {
  /** UUID of an AgoOauthConnection row. */
  @IsUUID()
  connectionId!: string;

  /** Where AGO should redirect after the user signs in. */
  @IsString()
  redirectUri!: string;
}

/**
 * Admin-only HTTP surface for AGO migration. Three concerns:
 *
 *   1. CRUD on the per-portal OAuth connection table. Operators
 *      register one connection per AGO portal they want to import
 *      from; each carries its own client_id.
 *   2. OAuth start: build the authorize URL with the looked-up
 *      client_id.
 *   3. The dry-run / run endpoints.
 *
 * Every endpoint is gated by AdminGuard. Connections have no
 * organization column and `orgHost` is unique across the install, so
 * creating, editing and deleting them is limited to admins of the
 * operator organization (OperatorOrgGuard). Any org admin can still
 * list them and start OAuth and an import with one.
 */
@ApiBearerAuth()
@ApiTags('admin', 'import-ago')
@Controller('admin/import-ago')
@UseGuards(AdminGuard)
export class ImportAgoController {
  constructor(
    private readonly dryRun: AgoDryRunService,
    private readonly importer: AgoImportService,
    private readonly connections: AgoConnectionsService,
    private readonly jobs: AgoImportJobsService,
  ) {}

  // ---- Connections CRUD ------------------------------------------------

  @Get('connections')
  async listConnections(): Promise<AgoConnectionDto[]> {
    return this.connections.list();
  }

  @Get('connections/:id')
  async getConnection(
    @Param('id') id: string,
  ): Promise<AgoConnectionDto> {
    return this.connections.getById(id);
  }

  @Post('connections')
  @UseGuards(OperatorOrgGuard)
  async createConnection(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateConnectionDto,
  ): Promise<AgoConnectionDto> {
    return this.connections.create(user, {
      orgUrl: dto.orgUrl,
      clientId: dto.clientId,
      ...(dto.displayName !== undefined && { displayName: dto.displayName }),
    });
  }

  @Patch('connections/:id')
  @UseGuards(OperatorOrgGuard)
  async updateConnection(
    @Param('id') id: string,
    @Body() dto: UpdateConnectionDto,
  ): Promise<AgoConnectionDto> {
    return this.connections.update(id, {
      ...(dto.displayName !== undefined && { displayName: dto.displayName }),
      ...(dto.clientId !== undefined && { clientId: dto.clientId }),
    });
  }

  @Delete('connections/:id')
  @UseGuards(OperatorOrgGuard)
  async deleteConnection(@Param('id') id: string): Promise<{ ok: true }> {
    await this.connections.delete(id);
    return { ok: true };
  }

  // ---- OAuth start -----------------------------------------------------

  /**
   * Build the AGO authorize URL the browser should send the user
   * to. Looks up the connection row by id to fetch the registered
   * client_id and the canonical sharing-rest base, embeds them in
   * /oauth2/authorize, and emits a CSRF state token the callback
   * page verifies.
   */
  @Post('oauth/start')
  async startOauth(@Body() dto: AgoOauthStartDto): Promise<{
    authorizeUrl: string;
    sharingRestBase: string;
    state: string;
    connection: AgoConnectionDto;
  }> {
    const conn = await this.connections.getById(dto.connectionId);
    // Re-normalize from the stored orgUrl in case the row's
    // orgUrl was hand-edited on the DB side. The normalizer
    // returning null on a row we created is a defensive case
    // worth surfacing as a 400 rather than a 500.
    const normalized = normalizeAgoUrl(conn.orgUrl);
    if (!normalized) {
      throw new BadRequestException(
        `Stored orgUrl on connection ${conn.id} is not parseable.`,
      );
    }
    if (!isHttpsUrl(dto.redirectUri)) {
      throw new BadRequestException(
        'redirectUri must be an https:// URL.',
      );
    }
    const state = randomBytes(24).toString('base64url');
    const authorizeUrl = buildAgoAuthorizeUrl({
      sharingRestBase: normalized.sharingRestBase,
      clientId: conn.clientId,
      redirectUri: dto.redirectUri,
      state,
      // Cap token lifetime at 60 min: importer dialogs are
      // short-lived; a leaked token expires fast.
      expirationMinutes: 60,
    });
    return {
      authorizeUrl,
      sharingRestBase: normalized.sharingRestBase,
      state,
      connection: conn,
    };
  }

  // ---- Import endpoints (unchanged) ------------------------------------

  @Post('preview')
  async preview(@Body() dto: AgoPreviewDto): Promise<DryRunReport> {
    if (!isHttpsUrl(dto.portalUrl)) {
      throw new BadRequestException(
        'portalUrl must be an https:// URL ending at the /sharing/rest root.',
      );
    }
    return this.dryRun.run({
      portalUrl: dto.portalUrl,
      token: dto.token,
      ...(dto.username !== undefined ? { username: dto.username } : {}),
    });
  }

  @Post('run')
  async run(
    @CurrentUser() user: AuthUser,
    @Body() dto: AgoRunDto,
  ): Promise<ImportReport> {
    if (!isHttpsUrl(dto.portalUrl)) {
      throw new BadRequestException(
        'portalUrl must be an https:// URL ending at the /sharing/rest root.',
      );
    }
    if (!dto.report || !Array.isArray(dto.report.items)) {
      throw new BadRequestException(
        'report must be the DryRunReport returned from /preview.',
      );
    }
    return this.importer.run({
      user,
      portalUrl: dto.portalUrl,
      token: dto.token,
      report: dto.report,
    });
  }

  // ---- Async ImportJob endpoints (#55) --------------------------------
  //
  // The wizard prefers the async path: a single HTTP request that
  // hangs open for 30+ minutes on a hosted-FS-heavy import is a
  // brittle UX. POST /run/start kicks off a background job and
  // returns immediately; the client polls /run/:id every second.
  // POST /run is kept around for API consumers and small imports
  // that don't need the polling overhead.

  /**
   * Queue an AGO migration job. Returns the new job id immediately;
   * the background runner picks up the row and writes progress as
   * it goes.
   */
  @Post('run/start')
  async runStart(
    @CurrentUser() user: AuthUser,
    @Body() dto: AgoRunDto,
  ): Promise<{ id: string }> {
    if (!isHttpsUrl(dto.portalUrl)) {
      throw new BadRequestException(
        'portalUrl must be an https:// URL ending at the /sharing/rest root.',
      );
    }
    if (!dto.report || !Array.isArray(dto.report.items)) {
      throw new BadRequestException(
        'report must be the DryRunReport returned from /preview.',
      );
    }
    return this.jobs.start({
      user,
      portalUrl: dto.portalUrl,
      token: dto.token,
      report: dto.report,
    });
  }

  /**
   * Poll one job. The wizard hits this every second while the job
   * is running. Once the status flips to a terminal value
   * (succeeded / failed / cancelled) the final report ships back
   * inline so the client doesn't need a second round-trip.
   */
  @Get('run/:id')
  async runStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<AgoImportJobDto> {
    return this.jobs.get(user, id);
  }

  /**
   * Cancel a running job. Returns the (cancelled) row. No-op when
   * the job has already finished.
   */
  @Post('run/:id/cancel')
  async runCancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<AgoImportJobDto> {
    return this.jobs.cancel(user, id);
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}
