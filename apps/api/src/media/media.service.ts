import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';

export const MAX_IMAGE = 8 * 1024 * 1024;
export const MAX_VIDEO = 40 * 1024 * 1024;
export const MAX_PER_ROOM_TYPE = 12;
const TYPES = { jpg: { type: 'image/jpeg', kind: 'IMAGE' }, png: { type: 'image/png', kind: 'IMAGE' }, webp: { type: 'image/webp', kind: 'IMAGE' }, mp4: { type: 'video/mp4', kind: 'VIDEO' }, webm: { type: 'video/webm', kind: 'VIDEO' } } as const;
type Ext = keyof typeof TYPES;

/** What the file really is, from its first bytes — the name and the browser's claim are not trusted. */
export function sniff(b: Buffer): Ext | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  return null;
}

const dir = () => process.env.MEDIA_DIR ?? join(process.cwd(), 'data', 'media');
/** Absolute address of the public file route, for emails. Falls back to a relative path. */
export const mediaUrl = (tenantId: string, fileName: string, base = process.env.PUBLIC_BASE_URL ?? '') => `${base.replace(/\/$/, '')}/v1/media/${tenantId}/${fileName}`;

@Injectable()
export class MediaService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService) {}

  private dto(tenantId: string, m: { id: string; kind: string; file_name: string; content_type: string; size_bytes: string; caption: string | null; sort_order: number }) {
    return { id: m.id, kind: m.kind, url: mediaUrl(tenantId, m.file_name, ''), contentType: m.content_type, sizeBytes: Number(m.size_bytes), caption: m.caption, sortOrder: m.sort_order };
  }

  async list(propertyId: string, roomTypeId: string) {
    const tenantId = currentTenant().tenantId;
    return this.tdb.tx(async (trx) => {
      const rows = await trx.selectFrom('room_type_media').selectAll().where('property_id', '=', propertyId).where('room_type_id', '=', roomTypeId).orderBy('sort_order').orderBy('created_at').execute();
      return { items: rows.map((m) => this.dto(tenantId, m)) };
    });
  }

  async add(propertyId: string, roomTypeId: string, data: Buffer, caption: string | null) {
    const tenantId = currentTenant().tenantId;
    const ext = sniff(data);
    if (!ext) throw new BadRequestException({ code: 'MEDIA_TYPE_UNSUPPORTED', message: 'Use a JPG, PNG or WebP picture, or an MP4 or WebM video' });
    const { type, kind } = TYPES[ext];
    if (data.length > (kind === 'IMAGE' ? MAX_IMAGE : MAX_VIDEO)) throw new PayloadTooLargeException({ code: 'MEDIA_TOO_LARGE', message: kind === 'IMAGE' ? 'Pictures can be up to 8 MB' : 'Videos can be up to 40 MB' });
    const fileName = `${randomBytes(16).toString('hex')}.${ext}`;
    const folder = join(dir(), tenantId);
    // The row is written first so the room-type check and the count limit are enforced; the file is removed again if the transaction fails.
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, fileName), data, { flag: 'wx' });
    try {
      return await this.tdb.tx(async (trx) => {
        const rt = await trx.selectFrom('room_type').select('id').where('id', '=', roomTypeId).where('property_id', '=', propertyId).executeTakeFirst();
        if (!rt) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room type not found' });
        const have = await trx.selectFrom('room_type_media').select(({ fn }) => fn.countAll<string>().as('n')).where('room_type_id', '=', roomTypeId).executeTakeFirstOrThrow();
        if (Number(have.n) >= MAX_PER_ROOM_TYPE) throw new ConflictException({ code: 'MEDIA_LIMIT', message: `A room type can have up to ${MAX_PER_ROOM_TYPE} pictures and videos` });
        const last = await trx.selectFrom('room_type_media').select(({ fn }) => fn.max('sort_order').as('m')).where('room_type_id', '=', roomTypeId).executeTakeFirst();
        const row = await trx.insertInto('room_type_media').values({
          tenant_id: tenantId, property_id: propertyId, room_type_id: roomTypeId, kind, file_name: fileName, content_type: type, size_bytes: String(data.length),
          caption: caption?.trim() ? caption.trim().slice(0, 160) : null, sort_order: (last?.m ?? -1) + 1, uploaded_by: currentTenant().actorId!,
        }).returningAll().executeTakeFirstOrThrow();
        await this.audit.record(trx, { action: 'room_type.media_add', resourceType: 'room_type', resourceId: roomTypeId, propertyId, after: { mediaId: row.id, kind, sizeBytes: data.length } });
        return this.dto(tenantId, row);
      });
    } catch (e) { await rm(join(folder, fileName), { force: true }); throw e; }
  }

  async update(propertyId: string, roomTypeId: string, id: string, i: { caption?: string | null; makeFirst?: boolean }) {
    const tenantId = currentTenant().tenantId;
    return this.tdb.tx(async (trx) => {
      const m = await trx.selectFrom('room_type_media').selectAll().where('id', '=', id).where('property_id', '=', propertyId).where('room_type_id', '=', roomTypeId).forUpdate().executeTakeFirst();
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
      if (i.caption !== undefined) await trx.updateTable('room_type_media').set({ caption: i.caption?.trim() ? i.caption.trim().slice(0, 160) : null }).where('id', '=', id).execute();
      if (i.makeFirst) {
        const all = await trx.selectFrom('room_type_media').select('id').where('room_type_id', '=', roomTypeId).orderBy('sort_order').orderBy('created_at').execute();
        const order = [id, ...all.map((r) => r.id).filter((x) => x !== id)];
        for (const [n, mid] of order.entries()) await trx.updateTable('room_type_media').set({ sort_order: n }).where('id', '=', mid).execute();
      }
      await this.audit.record(trx, { action: 'room_type.media_update', resourceType: 'room_type', resourceId: roomTypeId, propertyId, after: { mediaId: id, ...i } });
      return this.dto(tenantId, (await trx.selectFrom('room_type_media').selectAll().where('id', '=', id).executeTakeFirstOrThrow()));
    });
  }

  async remove(propertyId: string, roomTypeId: string, id: string) {
    const tenantId = currentTenant().tenantId;
    const gone = await this.tdb.tx(async (trx) => {
      const m = await trx.deleteFrom('room_type_media').where('id', '=', id).where('property_id', '=', propertyId).where('room_type_id', '=', roomTypeId).returning('file_name').executeTakeFirst();
      if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Picture not found' });
      await this.audit.record(trx, { action: 'room_type.media_remove', resourceType: 'room_type', resourceId: roomTypeId, propertyId, after: { mediaId: id } });
      return m.file_name;
    });
    await rm(join(dir(), tenantId, gone), { force: true });
  }

  /** Public read of one file: the name is 128 random bits, so possession of the link is the permission (the same way an emailed picture works). */
  async open(tenantId: string, fileName: string) {
    if (!/^[0-9a-f-]{36}$/.test(tenantId) || !/^[0-9a-f]{32}\.(jpg|png|webp|mp4|webm)$/.test(fileName)) throw new NotFoundException();
    const path = join(dir(), tenantId, fileName);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw new NotFoundException();
    const ext = fileName.split('.')[1] as Ext;
    return { size: st.size, type: TYPES[ext].type, stream: (range?: { start: number; end: number }) => createReadStream(path, range) };
  }

  /** Stores a picture or video for something shown to guests (a menu item): checked by its bytes, kept under an unguessable name, served by the public media route. */
  async storePublic(data: Buffer): Promise<{ fileName: string; kind: 'IMAGE' | 'VIDEO'; contentType: string; size: number }> {
    const ext = sniff(data);
    if (!ext) throw new BadRequestException({ code: 'MEDIA_TYPE_UNSUPPORTED', message: 'Use a JPG, PNG or WebP picture, or an MP4 or WebM video' });
    const { type, kind } = TYPES[ext];
    if (data.length > (kind === 'IMAGE' ? MAX_IMAGE : MAX_VIDEO)) throw new PayloadTooLargeException({ code: 'MEDIA_TOO_LARGE', message: kind === 'IMAGE' ? 'Pictures can be up to 8 MB' : 'Videos can be up to 40 MB' });
    const fileName = `${randomBytes(16).toString('hex')}.${ext}`;
    const folder = join(dir(), currentTenant().tenantId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, fileName), data, { flag: 'wx' });
    return { fileName, kind, contentType: type, size: data.length };
  }
  async removePublic(fileName: string) { if (/^[0-9a-f]{32}\.(jpg|png|webp|mp4|webm)$/.test(fileName)) await rm(join(dir(), currentTenant().tenantId, fileName), { force: true }); }
}
