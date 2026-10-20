import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addUser, as, assignRole, createTestApp, provision } from './harness.js';

process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'hos-media-'));

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>, O: Record<string, string>, other: Awaited<ReturnType<typeof provision>>;
let pid: string, rt: string;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64, 3)]);

function upload(url: string, headers: Record<string, string>, data: Buffer, name = 'room.jpg') {
  const b = '----hosboundary';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': `multipart/form-data; boundary=${b}` }, payload });
}

beforeAll(async () => {
  app = await createTestApp();
  T = await provision(app, 'media'); other = await provision(app, 'media2');
  O = as(T.tenantId, T.ownerUserId);
  pid = T.propertyIds[0];
  const r = await app.inject({ method: 'POST', url: `/v1/properties/${pid}/room-types`, headers: O, payload: { code: 'DLX', name: 'Deluxe', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, baseOccupancy: 2 } });
  rt = r.json().id;
});
afterAll(async () => { await app.close(); });

describe('room type pictures and videos', () => {
  const base = () => `/v1/properties/${pid}/room-types/${rt}/media`;

  it('stores a picture and serves it publicly with the right type', async () => {
    const r = await upload(base(), O, JPEG);
    expect(r.statusCode, r.body).toBe(201);
    const m = r.json();
    expect(m).toMatchObject({ kind: 'IMAGE', contentType: 'image/jpeg', sortOrder: 0 });
    const got = await app.inject({ method: 'GET', url: m.url });              // no sign-in
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.rawPayload.equals(JPEG)).toBe(true);
  });

  it('serves a video in ranges so it can be played and skipped through', async () => {
    const m = (await upload(base(), O, MP4, 'tour.mp4')).json();
    expect(m.kind).toBe('VIDEO');
    const part = await app.inject({ method: 'GET', url: m.url, headers: { range: 'bytes=0-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(10);
  });

  it('decides the type from the file, not its name', async () => {
    const r = await upload(base(), O, Buffer.from('<?php echo 1; ?>' + ' '.repeat(40)), 'evil.jpg');
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('MEDIA_TYPE_UNSUPPORTED');
  });

  it('lists in order, lets the manager make one the cover, caption it and remove it', async () => {
    const png = (await upload(base(), O, PNG, 'b.png')).json();
    const l1 = (await app.inject({ method: 'GET', url: base(), headers: O })).json().items;
    expect(l1.map((x: any) => x.id)[l1.length - 1]).toBe(png.id);
    const cover = await app.inject({ method: 'PATCH', url: `${base()}/${png.id}`, headers: O, payload: { makeFirst: true, caption: 'Bedroom' } });
    expect(cover.statusCode, cover.body).toBe(200);
    const l2 = (await app.inject({ method: 'GET', url: base(), headers: O })).json().items;
    expect(l2[0]).toMatchObject({ id: png.id, caption: 'Bedroom', sortOrder: 0 });
    expect((await app.inject({ method: 'DELETE', url: `${base()}/${png.id}`, headers: O })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: png.url })).statusCode).toBe(404);
  });

  it('needs property.manage to upload or remove, and refuses another business’s room type', async () => {
    const u = await addUser(T.tenantId, 'desk@media.test');
    await assignRole(T.tenantId, u, 'front_desk_agent', 'PROPERTY', pid);
    const desk = as(T.tenantId, u);
    expect((await upload(base(), desk, JPEG)).statusCode).toBe(403);
    const O2 = as(other.tenantId, other.ownerUserId);
    expect((await upload(`/v1/properties/${other.propertyIds[0]}/room-types/${rt}/media`, O2, JPEG)).statusCode).toBe(404);
  });

  it('only serves well-formed names and never leaves the media folder', async () => {
    for (const bad of [`${T.tenantId}/..%2F..%2Fetc%2Fpasswd`, `${T.tenantId}/abc.jpg`, `nope/${'a'.repeat(32)}.jpg`]) expect((await app.inject({ method: 'GET', url: `/v1/media/${bad}` })).statusCode).toBe(404);
  });

  it('stops at twelve per room type', async () => {
    let last = 201;
    for (let i = 0; i < 12; i++) last = (await upload(base(), O, JPEG)).statusCode;
    expect(last).toBe(409);
  });
});
