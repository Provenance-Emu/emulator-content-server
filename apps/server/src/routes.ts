import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { canonicalCidr, hashPassword, hashToken, issueToken, verifyPassword } from '@ecs/auth';
import type { CatalogDatabase, UploadRecord } from '@ecs/database';
import { type Actor, DomainError, type SourceAvailability } from '@ecs/domain';
import {
  assertSafeRelativePath,
  buildCapabilities,
  decodeCursor,
  encodeCursor,
  etagMatches,
  GUEST_CAPABILITIES,
  type GuestCapability,
  ITEM_PERMISSIONS,
  type ItemPermission,
  ifRangeMatches,
  isRestrictedAssetKind,
  LIBRARY_ROLES,
  type LibraryRole,
  openApiFile,
  PROVENANCE_SYSTEMS,
  parseChangeCursor,
  parseContentRange,
  parseSingleRange,
  strongEtag,
  validateAssetKind,
  validatePassword,
  validateSystemIdentifier,
  validateUsername,
} from '@ecs/protocol';
import {
  blobFileSize,
  blobPath,
  createStagingFile,
  ensureBlobStore,
  FileContentReader,
  hashFile,
  inspectRoot,
  listFolders,
  listVirtualEntries,
  locationOnline,
  openVirtualEntry,
  pathsOverlap,
  placeBlob,
  probeFile,
  probeRoot,
  removeStaging,
  resolveContentRoot,
  resolveInside,
  resolveStorageLocation,
  truncateStaging,
  writeAtOffset,
} from '@ecs/storage';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import {
  assetDecision,
  itemDecision,
  jsonObject,
  libraryDecision,
  optionalHex,
  optionalString,
  requireActor,
  requiredInteger,
  requiredString,
  stringList,
  withIdempotency,
} from './http.js';
import { accessView } from './local-access.js';

const REQUIRED_FILE_KINDS = new Set(['rom', 'bios', 'system_file']);

const UI_CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function registerRoutes(app: FastifyInstance, context: ServerContext): void {
  const { catalog } = context;

  const uploadMutations = new Set<string>();
  async function mutateUpload<T>(
    actor: Actor,
    uploadId: string,
    operation: (upload: UploadRecord) => Promise<T>,
  ): Promise<T> {
    const upload = requireOwnedUpload(catalog, actor, uploadId, 'write');
    if (upload.state !== 'open') throw new DomainError('upload-closed', 409, 'Upload is not open');
    if (uploadMutations.has(uploadId)) {
      throw new DomainError('upload-busy', 409, 'Another operation is changing this upload');
    }
    uploadMutations.add(uploadId);
    try {
      return await operation(upload);
    } finally {
      uploadMutations.delete(uploadId);
    }
  }

  const placements = new Map<string, number>();
  function reserveLocation(id: string): () => void {
    placements.set(id, (placements.get(id) ?? 0) + 1);
    return () => {
      const count = placements.get(id) ?? 0;
      if (count <= 1) placements.delete(id);
      else placements.set(id, count - 1);
    };
  }
  // Folder validation awaits filesystem metadata. Serialize competing additions
  // so a parent/child pair cannot both validate against an old catalog snapshot.
  let registration: Promise<void> = Promise.resolve();
  function registerFolder<T>(operation: () => Promise<T>): Promise<T> {
    const result = registration.then(operation);
    registration = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  app.get('/health', async () => ({ ok: true }));

  if (context.uiDir) {
    /**
     * The interface is static files on the same origin as `/api/v1`, which is
     * what keeps CORS out of the design. It is a single page, so there is no
     * history fallback to get wrong, and a request for a file that is not there
     * is a missing asset rather than a route.
     */
    app.register(fastifyStatic, {
      root: context.uiDir,
      prefix: '/ui/',
      // A wildcard route rather than one route per file discovered at startup,
      // so a rebuilt bundle is served without restarting. The prefix keeps it
      // clear of /api/v1, and the plugin refuses a path that leaves the
      // asset directory.
      wildcard: true,
      setHeaders: (response) => {
        /**
         * The page keeps its bearer token in local storage, so the thing that
         * has to be impossible is injected script reading it and sending it
         * somewhere. Nothing loads from another origin, nothing inline runs,
         * and the only place a request can go is back here.
         */
        response.header('content-security-policy', UI_CONTENT_POLICY);
        response.header('x-content-type-options', 'nosniff');
        response.header('referrer-policy', 'no-referrer');
      },
    });
    app.get('/ui', async (_request, reply) => reply.redirect('/ui/', 308));
  }

  app.get('/openapi.yaml', async (_request, reply) => {
    return reply.type('application/yaml').send(readFileSync(openApiFile(), 'utf8'));
  });

  app.get('/api/v1/capabilities', async () => {
    const policy = catalog.accessPolicy();
    return buildCapabilities({
      maxUploadBytes: catalog.limits.maxUploadBytes,
      virtualFormats: context.virtual.formats(),
      bootstrapped: catalog.server().bootstrapped,
      lanOpen: context.localTrust && policy.mode !== 'token',
    });
  });

  app.get('/api/v1/access', async (request) => accessView(context, request));

  app.put('/api/v1/access', async (request) => {
    const actor = requireOwner(request, 'Only the server owner can change who may connect');
    const body = jsonObject(request.body);
    const mode = requiredString(body, 'mode');
    if (mode !== 'lan' && mode !== 'token' && mode !== 'subnets') {
      throw new DomainError('invalid-body', 400, 'Access mode must be lan, token, or subnets');
    }
    const subnets = normalizeSubnets(body.subnets ?? []);
    catalog.setAccessPolicy({ mode, subnets, actorId: actor.userId });
    return accessView(context, request);
  });

  app.get('/api/v1/systems', async () => ({ systems: PROVENANCE_SYSTEMS, closed: false }));

  app.post('/api/v1/auth/bootstrap', async (request, reply) => {
    limit(context, request, 'bootstrap');
    const body = jsonObject(request.body);
    const token = requiredString(body, 'token');
    const username = requiredString(body, 'username');
    const password = requiredString(body, 'password');
    const usernameError = validateUsername(username);
    const passwordError = validatePassword(password);
    if (usernameError || passwordError) {
      throw new DomainError(
        'invalid-body',
        400,
        usernameError ?? passwordError ?? 'Invalid account',
      );
    }
    const session = issueToken();
    const result = catalog.bootstrap({
      bootstrapTokenHash: hashToken(token),
      username,
      passwordHash: hashPassword(password),
      sessionHash: session.hash,
      libraryName: 'Library',
    });
    await rm(join(context.dataDir, 'bootstrap.token'), { force: true });
    return reply.status(201).send({
      token: session.token,
      tokenType: 'Bearer',
      userId: result.userId,
      expiresAt: result.expiresAt,
    });
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    limit(context, request, 'login');
    const body = jsonObject(request.body);
    const username = requiredString(body, 'username');
    const password = requiredString(body, 'password');
    const user = catalog.findUser(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      catalog.recordAuthFailure(username);
      throw new DomainError('unauthorized', 401, 'Username or password is incorrect');
    }
    const session = issueToken();
    const created = catalog.createSession(user.id, session.hash);
    return reply.send({
      token: session.token,
      tokenType: 'Bearer',
      userId: user.id,
      expiresAt: created.expiresAt,
    });
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const actor = requireActor(request);
    catalog.revokeToken(
      hashToken(bearer(request)),
      actor.kind === 'user' ? actor.userId : actor.grantId,
    );
    return reply.status(204).send();
  });

  app.get('/api/v1/users', async (request) => {
    requireOwner(request, 'Only the server owner can list users');
    return { items: catalog.listUsers() };
  });

  app.post('/api/v1/users', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can create users');
    const body = jsonObject(request.body);
    const result = await withIdempotency(catalog, actor, request, body, async () => {
      const username = requiredString(body, 'username');
      const password = requiredString(body, 'password');
      const usernameError = validateUsername(username);
      const passwordError = validatePassword(password);
      if (usernameError || passwordError) {
        throw new DomainError(
          'invalid-body',
          400,
          usernameError ?? passwordError ?? 'Invalid account',
        );
      }
      let user: ReturnType<CatalogDatabase['createUser']>;
      try {
        user = catalog.createUser({
          username,
          passwordHash: hashPassword(password),
          actorId: actor.userId,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE')) {
          throw new DomainError('conflict', 409, 'That username is already in use');
        }
        throw error;
      }
      return { status: 201, body: user };
    });
    return reply.status(result.status).send(result.body);
  });

  app.patch('/api/v1/users/:userId', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can change a password');
    const { userId } = request.params as { userId: string };
    const password = requiredString(jsonObject(request.body), 'password');
    const passwordError = validatePassword(password);
    if (passwordError) throw new DomainError('invalid-body', 400, passwordError);
    const header = request.headers.authorization;
    const keep = header ? hashToken(bearer(request)) : null;
    if (!catalog.setPassword(userId, hashPassword(password), actor.userId, keep)) {
      throw new DomainError('not-found', 404, 'User not found');
    }
    return reply.status(204).send();
  });

  app.get('/api/v1/libraries', async (request) => {
    const actor = requireActor(request);
    if (actor.kind === 'guest') {
      libraryDecision(catalog, actor, actor.libraryId, 'read');
      const library = catalog.getLibrary(actor.libraryId);
      return { items: library ? [library] : [], nextCursor: null };
    }
    const seeAll = actor.isOwner || actor.localTrust === true;
    return { items: catalog.listLibraries(actor.userId, seeAll), nextCursor: null };
  });

  app.post('/api/v1/libraries', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const body = jsonObject(request.body);
    const name = requiredString(body, 'name').trim();
    if (name.length > 80) throw new DomainError('invalid-body', 400, 'Library name is too long');
    const library = catalog.createLibrary(actor.userId, name, deviceOf(actor));
    return reply.status(201).send(library);
  });

  app.put('/api/v1/libraries/:libraryId/members/:userId', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const { libraryId, userId } = request.params as { libraryId: string; userId: string };
    libraryDecision(catalog, actor, libraryId, 'admin');
    const role = requiredString(jsonObject(request.body), 'role');
    if (!LIBRARY_ROLES.includes(role as LibraryRole)) {
      throw new DomainError('invalid-body', 400, 'Role must be owner, editor, or reader');
    }
    catalog.setMember(libraryId, userId, role as LibraryRole, actor.userId);
    return reply.status(204).send();
  });

  app.delete('/api/v1/libraries/:libraryId/members/:userId', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const { libraryId, userId } = request.params as { libraryId: string; userId: string };
    libraryDecision(catalog, actor, libraryId, 'admin');
    if (!catalog.removeMember(libraryId, userId, actor.userId)) {
      throw new DomainError('not-found', 404, 'Membership not found');
    }
    return reply.status(204).send();
  });

  app.get('/api/v1/items', async (request) => {
    const actor = requireActor(request);
    const libraryId = queryString(request, 'libraryId');
    if (!libraryId) throw new DomainError('invalid-body', 400, 'libraryId is required');
    libraryDecision(catalog, actor, libraryId, 'read');
    const cursor = queryString(request, 'cursor');
    const afterId = cursor ? decodeCursor(cursor) : null;
    if (cursor && !afterId) throw new DomainError('invalid-body', 400, 'cursor is invalid');
    const page = catalog.listItems({
      libraryId,
      afterId,
      limit: pageLimit(request),
      itemId: actor.kind === 'guest' ? actor.itemId : null,
    });
    return {
      items: page.items,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    };
  });

  app.post('/api/v1/items', async (request, reply) => {
    const actor = requireActor(request);
    const body = jsonObject(request.body);
    const libraryId = requiredString(body, 'libraryId');
    libraryDecision(catalog, actor, libraryId, 'write');
    const result = await withIdempotency(catalog, actor, request, body, async () => {
      const systemIdentifier = requiredString(body, 'systemIdentifier');
      const systemError = validateSystemIdentifier(systemIdentifier);
      if (systemError) throw new DomainError('invalid-body', 400, systemError);
      const title = requiredString(body, 'title').trim();
      if (title.length > 300) throw new DomainError('invalid-body', 400, 'Title is too long');
      const item = catalog.createItem({
        libraryId,
        systemIdentifier,
        title,
        md5: optionalHex(body.md5, 32),
        crc: optionalHex(body.crc, 8),
        actorId: actor.kind === 'user' ? actor.userId : actor.grantId,
        deviceId: deviceOf(actor),
      });
      return { status: 201, body: item };
    });
    return reply
      .status(result.status)
      .header('etag', `"rev-${revisionOf(result.body)}"`)
      .send(result.body);
  });

  app.get('/api/v1/items/:itemId', async (request, reply) => {
    const actor = requireActor(request);
    const item = requireItem(catalog, (request.params as { itemId: string }).itemId);
    itemDecision(catalog, actor, item, 'read');
    return reply.header('etag', `"rev-${item.revision}"`).send(item);
  });

  app.patch('/api/v1/items/:itemId', async (request, reply) => {
    const actor = requireActor(request);
    const itemId = (request.params as { itemId: string }).itemId;
    const current = requireItem(catalog, itemId);
    itemDecision(catalog, actor, current, 'write');
    const body = jsonObject(request.body);
    const updated = catalog.updateItem({
      id: itemId,
      baseRevision: requireRevision(request),
      title: optionalString(body, 'title')?.trim(),
      md5: body.md5 === undefined ? undefined : optionalHex(body.md5, 32),
      crc: body.crc === undefined ? undefined : optionalHex(body.crc, 8),
      actorId: actor.kind === 'user' ? actor.userId : actor.grantId,
      deviceId: deviceOf(actor),
    });
    return reply.header('etag', `"rev-${updated.revision}"`).send(updated);
  });

  app.delete('/api/v1/items/:itemId', async (request, reply) => {
    const actor = requireActor(request);
    const item = requireItem(catalog, (request.params as { itemId: string }).itemId);
    itemDecision(catalog, actor, item, 'write');
    catalog.deleteItem(
      item.id,
      actor.kind === 'user' ? actor.userId : actor.grantId,
      deviceOf(actor),
    );
    return reply.status(204).send();
  });

  app.get('/api/v1/items/:itemId/manifest', async (request) => {
    const actor = requireActor(request);
    const item = requireItem(catalog, (request.params as { itemId: string }).itemId);
    itemDecision(catalog, actor, item, 'read');
    const manifest = catalog.manifest(item.id);
    if (!manifest) throw new DomainError('not-found', 404, 'Item not found');
    return {
      version: 1,
      itemId: item.id,
      revision: manifest.revision,
      files: manifest.files
        .filter((file) => canReadAsset(catalog, actor, item, file))
        .map((file) => ({
          id: file.id,
          kind: file.kind,
          relativePath: file.relativePath,
          sha256: file.sha256,
          md5: file.md5,
          crc: file.crc,
          size: file.size,
          required: REQUIRED_FILE_KINDS.has(file.kind),
          contentPath: `/api/v1/files/${file.id}/content`,
          conflictOf: file.conflictOf,
        })),
    };
  });

  app.put('/api/v1/items/:itemId/access/:userId', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const { itemId, userId } = request.params as { itemId: string; userId: string };
    const item = requireItem(catalog, itemId);
    itemDecision(catalog, actor, item, 'admin');
    const permission = requiredString(jsonObject(request.body), 'permission');
    if (!ITEM_PERMISSIONS.includes(permission as ItemPermission)) {
      throw new DomainError('invalid-body', 400, 'Permission must be read, write, or admin');
    }
    catalog.setItemPermission(itemId, userId, permission as ItemPermission, actor.userId);
    return reply.status(204).send();
  });

  app.delete('/api/v1/items/:itemId/access/:userId', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const { itemId, userId } = request.params as { itemId: string; userId: string };
    const item = requireItem(catalog, itemId);
    itemDecision(catalog, actor, item, 'admin');
    if (!catalog.removeItemPermission(itemId, userId, actor.userId)) {
      throw new DomainError('not-found', 404, 'Item grant not found');
    }
    return reply.status(204).send();
  });

  app.post('/api/v1/uploads', async (request, reply) => {
    const actor = requireActor(request);
    const body = jsonObject(request.body);
    const libraryId = requiredString(body, 'libraryId');
    libraryDecision(catalog, actor, libraryId, 'write');
    const result = await withIdempotency(catalog, actor, request, body, async () => {
      const upload = catalog.createUpload({
        userId: actor.kind === 'user' ? actor.userId : null,
        guestGrantId: actor.kind === 'guest' ? actor.grantId : null,
        libraryId,
      });
      await createStagingFile(context.dataDir, upload.id);
      return {
        status: 201,
        body: { id: upload.id, received: upload.received, state: upload.state },
      };
    });
    return reply.status(result.status).send(result.body);
  });

  app.put('/api/v1/uploads/:uploadId/content', async (request, reply) => {
    const actor = requireActor(request);
    const { uploadId } = request.params as { uploadId: string };
    return mutateUpload(actor, uploadId, async (upload) => {
      const header = request.headers['content-range'];
      let offset = upload.received;
      let expectedBytes: number | undefined;
      if (typeof header === 'string') {
        const parsed = parseContentRange(header);
        if (!parsed) throw new DomainError('invalid-body', 400, 'Content-Range is invalid');
        if (parsed.start !== upload.received) {
          throw new DomainError(
            'upload-gap',
            409,
            'Upload bytes must continue from the received offset',
          );
        }
        offset = parsed.start;
        expectedBytes = parsed.end - parsed.start + 1;
      }
      const declared = request.headers['content-length'];
      if (
        typeof declared === 'string' &&
        Number(declared) > catalog.limits.maxUploadBytes - offset
      ) {
        throw new DomainError('quota-exceeded', 413, 'Upload exceeds the configured byte quota');
      }
      await truncateStaging(stagingPath(context, upload.id), offset);
      const written = await writeAtOffset(
        stagingPath(context, upload.id),
        offset,
        asStream(request.body),
        catalog.limits.maxUploadBytes,
      );
      if (expectedBytes !== undefined && written !== expectedBytes) {
        await truncateStaging(stagingPath(context, upload.id), offset);
        throw new DomainError('invalid-body', 400, 'Body length does not match Content-Range');
      }
      catalog.setUploadReceived(upload.id, offset + written);
      return reply.status(204).send();
    });
  });

  app.post('/api/v1/uploads/:uploadId/complete', async (request, reply) => {
    const actor = requireActor(request);
    const uploadId = (request.params as { uploadId: string }).uploadId;
    const body = jsonObject(request.body);
    requireOwnedUpload(catalog, actor, uploadId, 'write');
    const item = requireItem(catalog, requiredString(body, 'itemId'));
    itemDecision(catalog, actor, item, 'write');
    const result = await withIdempotency(catalog, actor, request, body, async () => {
      return mutateUpload(actor, uploadId, async (upload) => {
        const kind = validateAssetKind(requiredString(body, 'kind'));
        if (!kind) throw new DomainError('invalid-body', 400, 'Unknown asset kind');
        let relativePath: string;
        try {
          relativePath = assertSafeRelativePath(requiredString(body, 'relativePath'));
        } catch (error) {
          throw new DomainError(
            'invalid-body',
            400,
            error instanceof Error ? error.message : 'Invalid path',
          );
        }
        await truncateStaging(stagingPath(context, upload.id), upload.received);
        if (upload.received === 0) throw new DomainError('invalid-body', 400, 'Upload is empty');
        const placed = await placeUploadBytes(
          context,
          stagingPath(context, upload.id),
          reserveLocation,
        );
        let asset: ReturnType<CatalogDatabase['completeUpload']>;
        try {
          asset = catalog.completeUpload({
            uploadId: upload.id,
            itemId: item.id,
            kind,
            displayName: requiredString(body, 'displayName'),
            relativePath,
            baseRevision: requiredInteger(body, 'baseRevision'),
            sha256: placed.sha256,
            size: placed.size,
            md5: placed.md5,
            crc: placed.crc,
            shareable: !isRestrictedAssetKind(kind),
            actorId: actor.kind === 'user' ? actor.userId : null,
            deviceId: deviceOf(actor),
            locationId: placed.locationId,
          });
        } finally {
          placed.release();
        }
        await removeStaging(context.dataDir, upload.id);
        return { status: 201, body: asset };
      });
    });
    return reply.status(result.status).send(result.body);
  });

  app.get('/api/v1/uploads/:uploadId', async (request) => {
    const actor = requireActor(request);
    const upload = requireOwnedUpload(
      catalog,
      actor,
      (request.params as { uploadId: string }).uploadId,
      'read',
    );
    return { id: upload.id, received: upload.received, state: upload.state };
  });

  app.delete('/api/v1/uploads/:uploadId', async (request, reply) => {
    const actor = requireActor(request);
    const { uploadId } = request.params as { uploadId: string };
    return mutateUpload(actor, uploadId, async (upload) => {
      if (!catalog.abortUpload(upload.id, actor.kind === 'user' ? actor.userId : null)) {
        throw new DomainError('upload-closed', 409, 'Upload is not open');
      }
      await removeStaging(context.dataDir, upload.id);
      return reply.status(204).send();
    });
  });

  app.get('/api/v1/files/:assetId', async (request) => {
    const { asset } = requireVisibleAsset(context, request, 'read');
    return asset;
  });

  app.delete('/api/v1/files/:assetId', async (request, reply) => {
    const actor = requireActor(request);
    const { asset } = requireVisibleAsset(context, request, 'write');
    catalog.deleteAsset(
      asset.id,
      actor.kind === 'user' ? actor.userId : actor.grantId,
      deviceOf(actor),
    );
    return reply.status(204).send();
  });

  app.post('/api/v1/files/:assetId/adopt', async (request) => {
    const actor = requireActor(request);
    const { asset } = requireVisibleAsset(context, request, 'write');
    return catalog.adoptConflict({
      assetId: asset.id,
      actorId: actor.kind === 'user' ? actor.userId : actor.grantId,
      deviceId: deviceOf(actor),
    });
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/v1/files/:assetId/content',
    handler: async (request, reply) => sendContent(context, request, reply),
  });

  app.get('/api/v1/files/:assetId/entries', async (request) => {
    const { asset } = requireVisibleAsset(context, request, 'read');
    const root = await blobRoot(context, asset.sha256);
    const inspected = await listVirtualEntries(
      root,
      asset.sha256,
      context.virtual,
      queryString(request, 'entry'),
      context.dataDir,
    );
    return {
      supported: inspected !== null,
      entries: inspected?.entries.map((entry) => entry.path) ?? [],
      format: inspected?.format ?? null,
      items: inspected?.entries ?? [],
    };
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/v1/files/:assetId/entries/:entryId/content',
    handler: async (request, reply) => sendEntryContent(context, request, reply),
  });

  app.get('/api/v1/changes', async (request) => {
    const actor = requireActor(request);
    if (actor.kind === 'user' && !actor.scopes.includes('read')) {
      throw new DomainError('forbidden', 403, 'This token cannot read');
    }
    const after = parseChangeCursor(queryString(request, 'cursor'));
    if (Number.isNaN(after)) throw new DomainError('invalid-body', 400, 'cursor is invalid');
    const includeSensitive =
      actor.kind === 'user' || actor.capabilities.includes('share_restricted');
    const page = catalog.changes({
      after,
      limit: pageLimit(request),
      libraryIds: catalog.visibleLibraryIds(actor),
      includeSensitive,
      itemId: actor.kind === 'guest' ? actor.itemId : null,
      excludeDeviceId: queryString(request, 'excludeOwnDevice') === '1' ? deviceOf(actor) : null,
    });
    return { changes: page.changes, nextCursor: String(page.nextCursor) };
  });

  app.get('/api/v1/guest-grants', async (request) => {
    requireOwner(request, 'Only the server owner can list guest grants');
    return { items: catalog.listGuestGrants(pageLimit(request)) };
  });

  app.post('/api/v1/guest-grants', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const body = jsonObject(request.body);
    const libraryId = requiredString(body, 'libraryId');
    libraryDecision(catalog, actor, libraryId, 'admin');
    const itemValue = body.itemId;
    const itemId =
      itemValue === undefined || itemValue === null || itemValue === ''
        ? null
        : requiredString(body, 'itemId');
    if (itemId) itemDecision(catalog, actor, requireItem(catalog, itemId), 'admin');
    const result = await withIdempotency(catalog, actor, request, body, async () => {
      const capabilities = stringList(body.capabilities).filter((item): item is GuestCapability =>
        GUEST_CAPABILITIES.includes(item as GuestCapability),
      );
      if (
        capabilities.length !== stringList(body.capabilities).length ||
        !capabilities.includes('read')
      ) {
        throw new DomainError('invalid-body', 400, 'Guest capabilities must include read');
      }
      const expiresInSeconds = requiredInteger(body, 'expiresInSeconds');
      if (expiresInSeconds < 60 || expiresInSeconds > 30 * 24 * 60 * 60) {
        throw new DomainError(
          'invalid-body',
          400,
          'Guest lifetime must be between 60 seconds and 30 days',
        );
      }
      const issued = issueToken();
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
      const grant = catalog.createGuestGrant({
        tokenHash: issued.hash,
        libraryId,
        itemId,
        capabilities,
        expiresAt,
        createdBy: actor.userId,
      });
      return { status: 201, body: { id: grant.id, token: issued.token, expiresAt } };
    });
    return reply.status(result.status).send(result.body);
  });

  app.delete('/api/v1/guest-grants/:grantId', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const { grantId } = request.params as { grantId: string };
    const libraryId = catalog.guestGrantLibraryId(grantId);
    if (!libraryId) throw new DomainError('not-found', 404, 'Guest grant not found');
    libraryDecision(catalog, actor, libraryId, 'admin');
    if (!catalog.revokeGuestGrant(grantId, actor.userId)) {
      throw new DomainError('not-found', 404, 'Guest grant not found');
    }
    return reply.status(204).send();
  });

  app.post('/api/v1/device-tokens', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const body = jsonObject(request.body);
    const result = await withIdempotency(catalog, actor, request, body, async () => {
      const name = requiredString(body, 'name').trim();
      if (name.length > 80) throw new DomainError('invalid-body', 400, 'Token name is too long');
      const scopes = stringList(body.scopes).filter((item): item is ItemPermission =>
        ITEM_PERMISSIONS.includes(item as ItemPermission),
      );
      if (scopes.length === 0 || scopes.length !== stringList(body.scopes).length) {
        throw new DomainError('invalid-body', 400, 'Device scopes must be read, write, or admin');
      }
      const expiresRaw = body.expiresInSeconds;
      let expiresAt: string | null = null;
      if (expiresRaw !== undefined && expiresRaw !== null) {
        if (
          typeof expiresRaw !== 'number' ||
          !Number.isSafeInteger(expiresRaw) ||
          expiresRaw < 60
        ) {
          throw new DomainError('invalid-body', 400, 'Device token lifetime is invalid');
        }
        expiresAt = new Date(Date.now() + expiresRaw * 1000).toISOString();
      }
      const issued = issueToken();
      const created = catalog.createDeviceToken({
        userId: actor.userId,
        name,
        tokenHash: issued.hash,
        scopes,
        expiresAt,
      });
      return { status: 201, body: { id: created.id, token: issued.token, scopes } };
    });
    return reply.status(result.status).send(result.body);
  });

  app.delete('/api/v1/device-tokens/:tokenId', async (request, reply) => {
    const actor = requireUser(request, 'admin');
    const { tokenId } = request.params as { tokenId: string };
    if (!catalog.revokeDeviceToken(tokenId, actor.userId)) {
      throw new DomainError('not-found', 404, 'Device token not found');
    }
    return reply.status(204).send();
  });

  app.get('/api/v1/folders', async (request) => {
    requireOwner(request, 'Only the owner can browse folders on this machine');
    return listFolders(queryString(request, 'path') ?? null);
  });

  app.get('/api/v1/storage-locations', async (request) => {
    requireOwner(request, 'Only the server owner can read storage locations');
    const items = await Promise.all(
      catalog.listStorageLocations().map(async (location) => ({
        ...location,
        online: await locationOnline(location.path),
      })),
    );
    return { items, writeLocationId: catalog.writeLocation()?.id ?? null };
  });

  app.post('/api/v1/storage-locations', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can add a storage location');
    const body = jsonObject(request.body);
    const label = requiredString(body, 'label');
    // Validate before initializing a folder; the catalog enforces this too.
    if (label.trim() !== label || label.length > 80 || /[\\/]/.test(label)) {
      throw new DomainError('invalid-location', 400, 'A location label must be 1-80 characters');
    }
    const location = await registerFolder(async () => {
      const saved = catalog.listStorageLocations();
      if (saved.some((location) => location.label === label)) {
        throw new DomainError('conflict', 409, 'That label is already used');
      }
      const path = await resolveStorageLocation(
        context.dataDir,
        requiredString(body, 'path'),
        saved.map((location) => location.path),
        catalog.listContentRoots().map((root) => root.path),
      );
      try {
        await ensureBlobStore(path);
      } catch {
        throw new DomainError(
          'invalid-location',
          400,
          'Unable to initialize blob storage in that folder',
        );
      }
      return catalog.createStorageLocation({ path, label, actorId: actor.userId });
    });
    return reply.code(201).send({ ...location, online: await locationOnline(location.path) });
  });

  app.put('/api/v1/storage-locations/write-target', async (request) => {
    const actor = requireOwner(
      request,
      'Only the server owner can select the storage write target',
    );
    const body = jsonObject(request.body);
    const id = body.id === null ? null : requiredString(body, 'id');
    catalog.setWriteLocation(id, actor.userId);
    return { id };
  });

  app.delete('/api/v1/storage-locations/:locationId', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can remove a storage location');
    const { locationId } = request.params as { locationId: string };
    if (placements.has(locationId)) {
      throw new DomainError('conflict', 409, 'That location has uploads completing');
    }
    catalog.deleteStorageLocation(locationId, actor.userId);
    return reply.code(204).send();
  });

  app.get('/api/v1/roots', async (request) => {
    requireOwner(request, 'Only the server owner can read content roots');
    return { items: catalog.listContentRoots(), nextCursor: null };
  });

  app.post('/api/v1/roots', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can save a content root');
    const body = jsonObject(request.body);
    const label = requiredString(body, 'label');
    const libraryId = optionalString(body, 'libraryId') ?? null;
    if (libraryId !== null && !catalog.getLibrary(libraryId)) {
      throw new DomainError('not-found', 404, 'Library not found');
    }
    const root = await registerFolder(async () => {
      const path = await resolveContentRoot(
        context.dataDir,
        requiredString(body, 'path'),
        catalog.listContentRoots().map((root) => root.path),
      );
      for (const location of catalog.listStorageLocations()) {
        if (pathsOverlap(path, location.path)) {
          throw new DomainError('conflict', 409, 'That folder overlaps a storage location');
        }
      }
      return catalog.createContentRoot({ path, label, libraryId, actorId: actor.userId });
    });
    reply.code(201);
    return root;
  });

  app.delete('/api/v1/roots/:rootId', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can remove a content root');
    const { rootId } = request.params as { rootId: string };
    catalog.deleteContentRoot(rootId, actor.userId);
    reply.code(204);
  });

  app.post('/api/v1/roots/:rootId/scan', async (request) => {
    const actor = requireUser(request, 'read');
    const { rootId } = request.params as { rootId: string };
    const root = requireVisibleRoot(catalog, actor, rootId);
    return scanRoot(catalog, root, actor.userId);
  });

  app.get('/api/v1/sources', async (request) => {
    const actor = requireActor(request);
    if (actor.kind === 'user' && !actor.scopes.includes('read')) {
      throw new DomainError('forbidden', 403, 'This token cannot read');
    }
    const items = [];
    for (const root of catalog.listContentRoots()) {
      if (!canSeeRoot(actor, root.libraryId, catalog)) continue;
      const probe = await probeRoot(root.path);
      if (!probe.online) catalog.markRootOffline(root.id);
      for (const source of catalog.listSources(root.id)) {
        if (!canSeeSource(actor, source.libraryId, source.kind)) continue;
        let availability: SourceAvailability = probe.online ? source.availability : 'offline';
        let size = source.size;
        if (probe.online) {
          const live = await probeFile(join(root.path, source.relativePath), probe.medium, true);
          availability = live.availability;
          size = live.size;
          catalog.updateSourcePresence(source.id, live);
        }
        items.push({
          id: source.id,
          rootId: source.rootId,
          libraryId: source.libraryId,
          name: source.displayName,
          kind: source.kind,
          size,
          systemId: source.systemId,
          availability,
          medium: probe.medium,
          contentPath: `/api/v1/sources/${source.id}/content`,
        });
      }
    }
    return { items };
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/v1/sources/:sourceId/content',
    handler: async (request, reply) => sendSourceContent(context, request, reply),
  });

  app.get('/api/v1/audit', async (request) => {
    requireOwner(request, 'Only the server owner can read the audit log');
    return { events: catalog.listAudit(pageLimit(request)) };
  });
}

function limit(context: ServerContext, request: FastifyRequest, name: string): void {
  if (!context.limiter.allow(`${name}:${request.ip}`)) {
    throw new DomainError('rate-limited', 429, 'Too many attempts');
  }
}

function requireUser(request: FastifyRequest, scope: ItemPermission): Actor & { kind: 'user' } {
  const actor = requireActor(request);
  if (actor.kind !== 'user' || !actor.scopes.includes(scope)) {
    throw new DomainError('forbidden', 403, 'This token cannot perform that action');
  }
  return actor;
}

/**
 * The device behind a request, when it authenticated with a device token. The
 * feed filter derives this from the actor rather than taking an id from the
 * query, so one device cannot ask the server to hide another device's changes.
 */
function deviceOf(actor: Actor): string | null {
  return actor.kind === 'user' ? actor.deviceId : null;
}

function normalizeSubnets(value: unknown): string[] {
  const listed = stringList(value);
  if (listed.length > 32) {
    throw new DomainError('invalid-body', 400, 'At most 32 subnets can be named');
  }
  const canonical = listed.map((item) => {
    const cidr = canonicalCidr(item.trim());
    if (!cidr) {
      throw new DomainError(
        'invalid-body',
        400,
        'A subnet must be a network such as 192.168.1.0/24, and it cannot be the whole internet',
      );
    }
    return cidr;
  });
  return [...new Set(canonical)];
}

function requireOwner(request: FastifyRequest, message: string): Actor & { kind: 'user' } {
  const actor = requireUser(request, 'admin');
  if (!actor.isOwner) throw new DomainError('forbidden', 403, message);
  return actor;
}

function requireItem(catalog: CatalogDatabase, id: string) {
  const item = catalog.getItem(id);
  if (!item) throw new DomainError('not-found', 404, 'Item not found');
  return item;
}

function requireOwnedUpload(
  catalog: CatalogDatabase,
  actor: Actor,
  id: string,
  action: ItemPermission,
): UploadRecord {
  const upload = catalog.getUpload(id);
  if (!upload) throw new DomainError('not-found', 404, 'Upload not found');
  const owned =
    actor.kind === 'user' ? upload.userId === actor.userId : upload.guestGrantId === actor.grantId;
  if (!owned) throw new DomainError('not-found', 404, 'Upload not found');
  if (!upload.libraryId) throw new DomainError('not-found', 404, 'Upload not found');
  libraryDecision(catalog, actor, upload.libraryId, action);
  return upload;
}

function requireVisibleAsset(
  context: ServerContext,
  request: FastifyRequest,
  action: ItemPermission,
) {
  const actor = requireActor(request);
  const asset = context.catalog.getAsset((request.params as { assetId: string }).assetId);
  if (!asset) throw new DomainError('not-found', 404, 'File not found');
  const item = requireItem(context.catalog, asset.itemId);
  assetDecision(context.catalog, actor, item, asset, action);
  return { actor, asset, item };
}

function canReadAsset(
  catalog: CatalogDatabase,
  actor: Actor,
  item: ReturnType<typeof requireItem>,
  asset: ReturnType<CatalogDatabase['getAsset']>,
): boolean {
  if (!asset) return false;
  try {
    assetDecision(catalog, actor, item, asset, 'read');
    return true;
  } catch {
    return false;
  }
}

function stagingPath(context: ServerContext, uploadId: string): string {
  return join(context.dataDir, 'staging', uploadId);
}

/**
 * New bytes go to the configured location. Bytes the catalog already has stay
 * in the one location that first stored them, so a later write target cannot
 * create a second copy of the same digest.
 */
async function placeUploadBytes(
  context: ServerContext,
  sourcePath: string,
  reserve: (id: string) => () => void,
): Promise<{
  release: () => void;
  sha256: string;
  size: number;
  md5: string;
  crc: string;
  locationId: string | null;
}> {
  const hashes = await hashFile(sourcePath);
  const existing = context.catalog.blobRecord(hashes.sha256);
  if (existing) {
    const root = await blobRoot(context, hashes.sha256);
    await placeBlob(root, sourcePath, hashes);
    return { ...hashes, locationId: existing.locationId, release: () => {} };
  }
  const write = context.catalog.writeLocation();
  // Pin before the first filesystem await and retain the reservation until the
  // catalog references the blob. Management may change the target meanwhile.
  const release = write ? reserve(write.id) : () => {};
  try {
    if (write && !(await locationOnline(write.path))) {
      throw new DomainError('location-offline', 503, `Storage location ${write.label} is offline`);
    }
    await placeBlob(write?.path ?? context.dataDir, sourcePath, hashes);
    return { ...hashes, locationId: write?.id ?? null, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** The directory that holds this digest. The data directory is the primary, and it has no row. */
async function blobRoot(context: ServerContext, sha256: string): Promise<string> {
  const record = context.catalog.blobRecord(sha256);
  if (!record?.locationId) return context.dataDir;
  const location = context.catalog.getStorageLocation(record.locationId);
  if (!location || !(await locationOnline(location.path))) {
    throw new DomainError(
      'location-offline',
      503,
      `Storage location ${location?.label ?? 'unknown'} is offline`,
    );
  }
  return location.path;
}

async function storedBlob(
  context: ServerContext,
  sha256: string,
): Promise<{ path: string; size: number }> {
  const root = await blobRoot(context, sha256);
  try {
    return { path: blobPath(root, sha256), size: await blobFileSize(root, sha256) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DomainError('not-found', 404, 'Stored bytes are missing');
    }
    throw error;
  }
}

function asStream(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (Buffer.isBuffer(body)) return Readable.from(body);
  throw new DomainError('invalid-body', 400, 'Expected an octet stream');
}

function requireVisibleRoot(
  catalog: CatalogDatabase,
  actor: Actor & { kind: 'user' },
  rootId: string,
) {
  const root = catalog.getContentRoot(rootId);
  if (!root || !canSeeRoot(actor, root.libraryId, catalog)) {
    throw new DomainError('not-found', 404, 'Content root not found');
  }
  return root;
}

async function scanRoot(
  catalog: CatalogDatabase,
  root: { id: string; path: string },
  actorId: string,
) {
  const inspected = await inspectRoot(root.path);
  const count = catalog.applyInspection({
    rootId: root.id,
    actorId,
    online: inspected.online,
    files: inspected.files,
  });
  return { rootId: root.id, medium: inspected.medium, online: inspected.online, count };
}

function canSeeRoot(actor: Actor, libraryId: string | null, catalog: CatalogDatabase): boolean {
  if (actor.kind === 'guest') return libraryId === actor.libraryId;
  if (actor.isOwner || actor.localTrust === true) return true;
  if (libraryId === null) return false;
  return catalog.visibleLibraryIds(actor).includes(libraryId);
}

function canSeeSource(actor: Actor, libraryId: string | null, kind: string): boolean {
  if (actor.kind !== 'guest') return true;
  if (libraryId !== actor.libraryId) return false;
  const parsed = validateAssetKind(kind);
  return !(
    parsed &&
    isRestrictedAssetKind(parsed) &&
    !actor.capabilities.includes('share_restricted')
  );
}

async function sendSourceContent(
  context: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const actor = requireActor(request);
  if (actor.kind === 'user' && !actor.scopes.includes('read')) {
    throw new DomainError('forbidden', 403, 'This token cannot read');
  }
  const { sourceId } = request.params as { sourceId: string };
  const source = context.catalog.getSource(sourceId);
  if (!source || !canSeeSource(actor, source.libraryId, source.kind)) {
    throw new DomainError('not-found', 404, 'Source file not found');
  }
  if (!canSeeRoot(actor, source.libraryId, context.catalog)) {
    throw new DomainError('not-found', 404, 'Source file not found');
  }
  const root = context.catalog.getContentRoot(source.rootId);
  if (!root) throw new DomainError('not-found', 404, 'Source file not found');
  const probe = await probeRoot(root.path);
  if (!probe.online) {
    context.catalog.markRootOffline(root.id);
    throw new DomainError('source-offline', 503, 'That disk is not connected');
  }
  let full: string;
  try {
    full = await resolveInside(root.path, source.relativePath);
  } catch {
    throw new DomainError('not-found', 404, 'Source file not found');
  }
  const live = await probeFile(full, probe.medium, true);
  context.catalog.updateSourcePresence(source.id, live);
  if (live.availability === 'evicted') {
    throw new DomainError('source-evicted', 409, 'That file is only a placeholder on this machine');
  }
  if (live.availability === 'offline') {
    throw new DomainError('source-offline', 503, 'That disk is not connected');
  }
  const etag = strongEtag(`source-${source.id}-${live.size}`);
  reply.header('accept-ranges', 'bytes');
  reply.header('etag', etag);
  if (etagMatches(headerString(request, 'if-none-match'), etag)) {
    return reply.status(304).send();
  }
  return sendRange(request, reply, { path: full, offset: 0, size: live.size, etag });
}

async function sendContent(
  context: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { asset } = requireVisibleAsset(context, request, 'read');
  const stored = await storedBlob(context, asset.sha256);
  const etag = strongEtag(asset.sha256);
  reply.header('accept-ranges', 'bytes');
  reply.header('etag', etag);
  if (etagMatches(headerString(request, 'if-none-match'), etag)) {
    return reply.status(304).send();
  }
  return sendRange(request, reply, {
    path: stored.path,
    offset: 0,
    size: stored.size,
    etag,
  });
}

async function sendEntryContent(
  context: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { asset } = requireVisibleAsset(context, request, 'read');
  const root = await blobRoot(context, asset.sha256);
  const { entryId } = request.params as { entryId: string };
  const etag = strongEtag(`${asset.sha256}-${entryId}`);
  reply.header('accept-ranges', 'bytes');
  reply.header('etag', etag);
  if (etagMatches(headerString(request, 'if-none-match'), etag)) {
    return reply.status(304).send();
  }
  const entry = await openVirtualEntry(
    root,
    asset.sha256,
    context.virtual,
    entryId,
    context.dataDir,
  );
  if (!entry) throw new DomainError('not-found', 404, 'Archive entry not found');
  return sendRange(request, reply, {
    path: entry.path,
    offset: entry.offset,
    size: entry.size,
    etag,
  });
}

async function sendRange(
  request: FastifyRequest,
  reply: FastifyReply,
  source: { path: string; offset: number; size: number; etag: string },
): Promise<FastifyReply> {
  const { size } = source;
  const rangeHeader = headerString(request, 'range');
  let status = 200;
  let start = 0;
  let end = Math.max(size - 1, 0);
  if (rangeHeader && ifRangeMatches(headerString(request, 'if-range'), source.etag)) {
    const parsed = parseSingleRange(rangeHeader, size);
    if (parsed.type === 'invalid') {
      throw new DomainError('invalid-range', 400, 'Only one byte range is supported');
    }
    if (parsed.type === 'unsatisfiable') {
      return reply.status(416).header('content-range', `bytes */${size}`).send();
    }
    status = 206;
    start = parsed.start;
    end = parsed.end;
    reply.header('content-range', `bytes ${start}-${end}/${size}`);
  }
  const length = size === 0 ? 0 : end - start + 1;
  reply.header('content-type', 'application/octet-stream');
  reply.header('content-length', String(length));
  if (request.method === 'HEAD' || length === 0) return reply.status(status).send();
  const reader = new FileContentReader(source.path, source.offset + size);
  return reply.status(status).send(reader.openRange(source.offset + start, source.offset + end));
}

function headerString(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function queryString(request: FastifyRequest, key: string): string | undefined {
  if (!request.query || typeof request.query !== 'object') return undefined;
  const value = (request.query as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DomainError('invalid-body', 400, `Invalid ${key}`);
  return value;
}

function pageLimit(request: FastifyRequest): number {
  const raw = queryString(request, 'limit');
  if (!raw) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DomainError('invalid-body', 400, 'limit must be 1-100');
  }
  return limit;
}

function requireRevision(request: FastifyRequest): number {
  const header = headerString(request, 'if-match');
  const match = header ? /^"rev-(\d+)"$/.exec(header.trim()) : null;
  if (!match?.[1]) throw new DomainError('precondition-required', 428, 'If-Match must be "rev-N"');
  return Number(match[1]);
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/.exec(header) : null;
  if (!match?.[1]) throw new DomainError('unauthorized', 401, 'Bearer token is required');
  return match[1];
}

function revisionOf(body: unknown): number {
  if (!body || typeof body !== 'object' || !('revision' in body)) return 0;
  const revision = (body as { revision?: unknown }).revision;
  return typeof revision === 'number' ? revision : 0;
}
