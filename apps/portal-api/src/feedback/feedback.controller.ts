// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { Public } from '../auth/public.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { FeedbackService } from './feedback.service.js';
import { MAX_SCREENSHOT_BYTES, isFeedbackEnabled } from './feedback-config.js';
import { sniffImage } from './image-sniff.js';

/**
 * Feedback DTO (#146). Honeypot field `company` is included BUT it is
 * supposed to stay empty: a real user never sees it (the frontend
 * hides it via off-screen positioning + tabindex=-1). Bots scraping
 * form fields almost always fill every input; a non-empty `company`
 * signals "this submission is automated, drop it." The controller
 * silently 200s on honeypot hits so the bot does not get a signal
 * that we caught it.
 *
 * Everything except `message` is optional, including all the context
 * fields, because the form must keep working for someone with a
 * privacy extension that blocks half of them.
 */
class SubmitFeedbackDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsString() @MinLength(2) @MaxLength(10000) message!: string;
  @IsOptional() @IsString() @MaxLength(2000) pageUrl?: string;
  @IsOptional() @IsString() @MaxLength(64) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(32) viewport?: string;
  /** Honeypot. Hidden in the UI; bots fill it. */
  @IsOptional() @IsString() @MaxLength(500) company?: string;
}

@ApiTags('public')
@Controller('feedback')
export class FeedbackController {
  private readonly log = new Logger(FeedbackController.name);

  constructor(private readonly feedback: FeedbackService) {}

  /**
   * Feedback intake. Public by design: the entire point is that
   * someone without an account, and without a GitHub login, can
   * report a problem.
   *
   * Accepts multipart so an optional screenshot can ride along; a
   * plain JSON body still works and is what the form sends when no
   * image is attached.
   *
   * Returns `{ ok: true }` once the submission is stored. Whether the
   * notification email went out is deliberately not reflected in the
   * response: the row is durable either way, and telling the reporter
   * "something failed" would only produce a duplicate.
   */
  @Public()
  @Post()
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('screenshot', { limits: { fileSize: MAX_SCREENSHOT_BYTES } }),
  )
  async submit(
    @Body() dto: SubmitFeedbackDto,
    @Req() req: Request,
    @UploadedFile() screenshot?: { buffer: Buffer; mimetype: string },
  ): Promise<{ ok: true }> {
    // 404 rather than 403 when the feature is off: an operator who
    // has not enabled feedback has no endpoint here, and saying so
    // is more honest than implying they merely lack permission.
    if (!isFeedbackEnabled()) {
      throw new NotFoundException('Cannot POST /feedback');
    }

    // Honeypot first. Silently swallow, and do NOT store: a stored
    // bot submission would count against the reporter's own rate
    // limit budget for that address.
    if (dto.company && dto.company.trim().length > 0) {
      this.log.warn(
        `feedback honeypot tripped ip=${clientIp(req)} ua="${truncate(
          req.headers['user-agent'] ?? '',
          80,
        )}"`,
      );
      return { ok: true };
    }

    const ip = clientIp(req);
    if (await this.feedback.isRateLimited(ip)) {
      this.log.warn('feedback rate-limited (hashed source)');
      throw new HttpException(
        'Too many submissions from your network. Try again in a few minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const message = dto.message.trim();
    if (message.length < 2) {
      throw new BadRequestException('Message is required.');
    }

    // The declared mimetype is attacker-controlled on a public
    // endpoint, so the bytes decide. An unrecognised attachment is
    // refused loudly rather than dropped, because a reporter who
    // attached something deserves to know it did not arrive.
    let attachment: { body: Buffer; contentType: string } | undefined;
    if (screenshot?.buffer && screenshot.buffer.length > 0) {
      const sniffed = sniffImage(screenshot.buffer);
      if (!sniffed) {
        throw new BadRequestException(
          'That attachment is not a PNG, JPEG, WebP, or GIF image.',
        );
      }
      attachment = { body: screenshot.buffer, contentType: sniffed };
    }

    // A signed-in reporter is recorded so the maintainer can reply
    // and can see which account hit the problem. The global auth
    // guard is opted out of via @Public(), so `req.user` is present
    // only when a valid token happened to be attached; it is never
    // required.
    const user = (req as Request & { user?: AuthUser }).user;

    await this.feedback.submit({
      ...(dto.name ? { name: dto.name.trim() } : {}),
      ...(dto.email ? { email: dto.email.trim() } : {}),
      message,
      ...(dto.pageUrl ? { pageUrl: dto.pageUrl.trim() } : {}),
      ...(dto.appVersion ? { appVersion: dto.appVersion.trim() } : {}),
      ...(dto.viewport ? { viewport: dto.viewport.trim() } : {}),
      ...(req.headers['user-agent']
        ? { userAgent: truncate(String(req.headers['user-agent']), 512) }
        : {}),
      ...(user?.id ? { userId: user.id } : {}),
      ...(user?.orgId ? { orgId: user.orgId } : {}),
      ip,
      ...(attachment ? { screenshot: attachment } : {}),
    });

    return { ok: true };
  }
}

/**
 * Best-effort client IP, read from the RIGHT of X-Forwarded-For.
 *
 * This keys the feedback rate limiter and the stored ipHash, so getting
 * it wrong is a bypass, not a cosmetic bug. The previous version took
 * the LEFTMOST entry, which is attacker-controlled: Caddy appends the
 * real peer to whatever X-Forwarded-For the client sent, so a client
 * that sends `X-Forwarded-For: 9.9.9.9` makes the leftmost value 9.9.9.9
 * and gets a fresh rate-limit budget per request, plus poisons every
 * stored hash. Confirmed on the box: the Caddyfile sets no
 * trusted_proxies and no XFF handling, so it appends rather than
 * replaces.
 *
 * Caddy is the single edge proxy (it binds :443 directly), so it appends
 * exactly one hop: the true client. The RIGHTMOST entry is therefore the
 * real immediate peer and cannot be forged by the client, whatever it
 * stuffs to the left. Caddy's trusted_proxies is also set now as
 * defence-in-depth, but reading from the right is the property that does
 * not depend on proxy config.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[fwd.length - 1] : fwd;
  if (typeof raw === 'string' && raw.length > 0) {
    const parts = raw.split(',');
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
