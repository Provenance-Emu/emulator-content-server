// Generated from packages/protocol/openapi/openapi.yaml. Do not edit.

import Foundation

public struct Problem: Codable, Equatable, Sendable {
    public var type: String
    public var title: String
    public var status: Int
    public var detail: String?
    public var instance: String?
    public var requestId: String?

    public init(type: String, title: String, status: Int, detail: String? = nil, instance: String? = nil, requestId: String? = nil) {
        self.type = type
        self.title = title
        self.status = status
        self.detail = detail
        self.instance = instance
        self.requestId = requestId
    }
}

public struct Capabilities: Codable, Equatable, Sendable {
    public var `protocol`: ProtocolInfo
    public var minClientVersion: String
    public var features: FeatureFlags
    public var limits: Limits
    public var authentication: [String]
    public var bootstrapped: Bool?

    public init(`protocol`: ProtocolInfo, minClientVersion: String, features: FeatureFlags, limits: Limits, authentication: [String], bootstrapped: Bool? = nil) {
        self.`protocol` = `protocol`
        self.minClientVersion = minClientVersion
        self.features = features
        self.limits = limits
        self.authentication = authentication
        self.bootstrapped = bootstrapped
    }
}

public struct ProtocolInfo: Codable, Equatable, Sendable {
    public var major: Int
    public var minor: Int
    public var path: String

    public init(major: Int, minor: Int, path: String) {
        self.major = major
        self.minor = minor
        self.path = path
    }
}

public struct FeatureFlags: Codable, Equatable, Sendable {
    public var rangeRequests: Bool
    public var multiRange: Bool
    public var resumableUploads: Bool
    public var changeFeed: Bool
    public var guestGrants: Bool
    public var virtualFormats: [String]
    public var webdav: Bool
    public var natTraversal: Bool
    public var webPlayback: Bool?

    public init(rangeRequests: Bool, multiRange: Bool, resumableUploads: Bool, changeFeed: Bool, guestGrants: Bool, virtualFormats: [String], webdav: Bool, natTraversal: Bool, webPlayback: Bool? = nil) {
        self.rangeRequests = rangeRequests
        self.multiRange = multiRange
        self.resumableUploads = resumableUploads
        self.changeFeed = changeFeed
        self.guestGrants = guestGrants
        self.virtualFormats = virtualFormats
        self.webdav = webdav
        self.natTraversal = natTraversal
        self.webPlayback = webPlayback
    }
}

public struct PlayerCoreResource: Codable, Equatable, Sendable {
    public var url: String
    public var sha256: String
    public var sizeBytes: Int64

    public init(url: String, sha256: String, sizeBytes: Int64) {
        self.url = url
        self.sha256 = sha256
        self.sizeBytes = sizeBytes
    }
}

public struct PlayerCoreDescriptor: Codable, Equatable, Sendable {
    public var version: Int
    public var id: String
    public var name: String
    public var systems: [String]
    public var runtime: String
    public var threaded: Bool
    public var filesystem: String
    public var saveCompletion: String
    public var frontendCommit: String
    public var coreCommit: String
    public var emscriptenVersion: String
    public var contentExtension: String
    public var maxContentBytes: Int64
    public var loader: PlayerCoreResource
    public var wasm: PlayerCoreResource

    public init(version: Int, id: String, name: String, systems: [String], runtime: String, threaded: Bool, filesystem: String, saveCompletion: String, frontendCommit: String, coreCommit: String, emscriptenVersion: String, contentExtension: String, maxContentBytes: Int64, loader: PlayerCoreResource, wasm: PlayerCoreResource) {
        self.version = version
        self.id = id
        self.name = name
        self.systems = systems
        self.runtime = runtime
        self.threaded = threaded
        self.filesystem = filesystem
        self.saveCompletion = saveCompletion
        self.frontendCommit = frontendCommit
        self.coreCommit = coreCommit
        self.emscriptenVersion = emscriptenVersion
        self.contentExtension = contentExtension
        self.maxContentBytes = maxContentBytes
        self.loader = loader
        self.wasm = wasm
    }
}

public struct Limits: Codable, Equatable, Sendable {
    public var maxUploadBytes: Int64
    public var maxPageSize: Int

    public init(maxUploadBytes: Int64, maxPageSize: Int) {
        self.maxUploadBytes = maxUploadBytes
        self.maxPageSize = maxPageSize
    }
}

public struct SystemSummary: Codable, Equatable, Sendable {
    public var identifier: String
    public var name: String

    public init(identifier: String, name: String) {
        self.identifier = identifier
        self.name = name
    }
}

public struct SystemList: Codable, Equatable, Sendable {
    public var systems: [SystemSummary]
    public var closed: Bool

    public init(systems: [SystemSummary], closed: Bool) {
        self.systems = systems
        self.closed = closed
    }
}

public struct Library: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var canCreateItems: Bool?
    public var ownerId: String
    public var revision: Int
    public var createdAt: String

    public init(id: String, name: String, canCreateItems: Bool? = nil, ownerId: String, revision: Int, createdAt: String) {
        self.id = id
        self.name = name
        self.canCreateItems = canCreateItems
        self.ownerId = ownerId
        self.revision = revision
        self.createdAt = createdAt
    }
}

public struct LibraryList: Codable, Equatable, Sendable {
    public var items: [Library]
    public var nextCursor: String?

    public init(items: [Library], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

public struct LibraryDraft: Codable, Equatable, Sendable {
    public var name: String

    public init(name: String) {
        self.name = name
    }
}

public struct FolderEntry: Codable, Equatable, Sendable {
    public var name: String
    public var path: String

    public init(name: String, path: String) {
        self.name = name
        self.path = path
    }
}

public struct FolderPlace: Codable, Equatable, Sendable {
    public var label: String
    public var path: String

    public init(label: String, path: String) {
        self.label = label
        self.path = path
    }
}

public struct FolderListing: Codable, Equatable, Sendable {
    public var path: String
    public var parent: String?
    public var entries: [FolderEntry]
    public var places: [FolderPlace]

    public init(path: String, parent: String? = nil, entries: [FolderEntry], places: [FolderPlace]) {
        self.path = path
        self.parent = parent
        self.entries = entries
        self.places = places
    }
}

public struct WebDavCredential: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var username: String
    public var createdAt: String
    public var expiresAt: String
    public var revokedAt: String?

    public init(id: String, name: String, username: String, createdAt: String, expiresAt: String, revokedAt: String? = nil) {
        self.id = id
        self.name = name
        self.username = username
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.revokedAt = revokedAt
    }
}

public struct WebDavCredentialList: Codable, Equatable, Sendable {
    public var items: [WebDavCredential]

    public init(items: [WebDavCredential]) {
        self.items = items
    }
}

public struct WebDavCredentialDraft: Codable, Equatable, Sendable {
    public var name: String
    public var expiresInSeconds: Int?

    public init(name: String, expiresInSeconds: Int? = nil) {
        self.name = name
        self.expiresInSeconds = expiresInSeconds
    }
}

public struct WebDavCredentialCreated: Codable, Equatable, Sendable {
    public var credential: WebDavCredential
    public var password: String

    public init(credential: WebDavCredential, password: String) {
        self.credential = credential
        self.password = password
    }
}

public struct StorageLocation: Codable, Equatable, Sendable {
    public var id: String
    public var path: String
    public var label: String
    public var createdAt: String
    public var online: Bool

    public init(id: String, path: String, label: String, createdAt: String, online: Bool) {
        self.id = id
        self.path = path
        self.label = label
        self.createdAt = createdAt
        self.online = online
    }
}

public struct StorageLocationList: Codable, Equatable, Sendable {
    public var items: [StorageLocation]
    public var writeLocationId: String?

    public init(items: [StorageLocation], writeLocationId: String? = nil) {
        self.items = items
        self.writeLocationId = writeLocationId
    }
}

public struct StorageLocationDraft: Codable, Equatable, Sendable {
    public var path: String
    public var label: String

    public init(path: String, label: String) {
        self.path = path
        self.label = label
    }
}

public struct StorageWriteTarget: Codable, Equatable, Sendable {
    public var id: String?

    public init(id: String? = nil) {
        self.id = id
    }
}

public struct ContentRoot: Codable, Equatable, Sendable {
    public var id: String
    public var path: String
    public var label: String
    public var libraryId: String?
    public var createdAt: String

    public init(id: String, path: String, label: String, libraryId: String? = nil, createdAt: String) {
        self.id = id
        self.path = path
        self.label = label
        self.libraryId = libraryId
        self.createdAt = createdAt
    }
}

public struct ContentRootList: Codable, Equatable, Sendable {
    public var items: [ContentRoot]
    public var nextCursor: String?

    public init(items: [ContentRoot], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

public struct ContentRootDraft: Codable, Equatable, Sendable {
    public var path: String
    public var label: String
    public var libraryId: String?

    public init(path: String, label: String, libraryId: String? = nil) {
        self.path = path
        self.label = label
        self.libraryId = libraryId
    }
}

public struct ContentRootScan: Codable, Equatable, Sendable {
    public var rootId: String
    public var medium: String
    public var online: Bool
    public var count: Int

    public init(rootId: String, medium: String, online: Bool, count: Int) {
        self.rootId = rootId
        self.medium = medium
        self.online = online
        self.count = count
    }
}

public struct SourceFile: Codable, Equatable, Sendable {
    public var id: String
    public var rootId: String
    public var libraryId: String?
    public var name: String
    public var kind: String
    public var size: Int64
    public var systemId: String?
    public var availability: String
    public var medium: String
    public var contentPath: String

    public init(id: String, rootId: String, libraryId: String? = nil, name: String, kind: String, size: Int64, systemId: String? = nil, availability: String, medium: String, contentPath: String) {
        self.id = id
        self.rootId = rootId
        self.libraryId = libraryId
        self.name = name
        self.kind = kind
        self.size = size
        self.systemId = systemId
        self.availability = availability
        self.medium = medium
        self.contentPath = contentPath
    }
}

public struct SourceFileList: Codable, Equatable, Sendable {
    public var items: [SourceFile]

    public init(items: [SourceFile]) {
        self.items = items
    }
}

public struct Item: Codable, Equatable, Sendable {
    public var id: String
    public var libraryId: String
    public var systemIdentifier: String
    public var title: String
    public var md5: String?
    public var crc: String?
    public var revision: Int
    public var createdAt: String
    public var updatedAt: String

    public init(id: String, libraryId: String, systemIdentifier: String, title: String, md5: String? = nil, crc: String? = nil, revision: Int, createdAt: String, updatedAt: String) {
        self.id = id
        self.libraryId = libraryId
        self.systemIdentifier = systemIdentifier
        self.title = title
        self.md5 = md5
        self.crc = crc
        self.revision = revision
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct ItemList: Codable, Equatable, Sendable {
    public var items: [Item]
    public var nextCursor: String?

    public init(items: [Item], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

public struct ItemDraft: Codable, Equatable, Sendable {
    public var libraryId: String
    public var systemIdentifier: String
    public var title: String
    public var md5: String?
    public var crc: String?

    public init(libraryId: String, systemIdentifier: String, title: String, md5: String? = nil, crc: String? = nil) {
        self.libraryId = libraryId
        self.systemIdentifier = systemIdentifier
        self.title = title
        self.md5 = md5
        self.crc = crc
    }
}

public struct ItemPatch: Codable, Equatable, Sendable {
    public var title: String?
    public var md5: String?
    public var crc: String?

    public init(title: String? = nil, md5: String? = nil, crc: String? = nil) {
        self.title = title
        self.md5 = md5
        self.crc = crc
    }
}

public struct Asset: Codable, Equatable, Sendable {
    public var id: String
    public var itemId: String
    public var kind: String
    public var displayName: String
    public var relativePath: String
    public var sha256: String
    public var size: Int64
    public var md5: String?
    public var crc: String?
    public var shareable: Bool
    public var revision: Int
    public var createdAt: String
    public var updatedAt: String
    public var conflictOf: String?

    public init(id: String, itemId: String, kind: String, displayName: String, relativePath: String, sha256: String, size: Int64, md5: String? = nil, crc: String? = nil, shareable: Bool, revision: Int, createdAt: String, updatedAt: String, conflictOf: String? = nil) {
        self.id = id
        self.itemId = itemId
        self.kind = kind
        self.displayName = displayName
        self.relativePath = relativePath
        self.sha256 = sha256
        self.size = size
        self.md5 = md5
        self.crc = crc
        self.shareable = shareable
        self.revision = revision
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.conflictOf = conflictOf
    }
}

public struct ManifestFile: Codable, Equatable, Sendable {
    public var id: String
    public var kind: String
    public var relativePath: String
    public var sha256: String
    public var md5: String?
    public var crc: String?
    public var size: Int64
    public var required: Bool
    public var contentPath: String
    public var conflictOf: String?

    public init(id: String, kind: String, relativePath: String, sha256: String, md5: String? = nil, crc: String? = nil, size: Int64, required: Bool, contentPath: String, conflictOf: String? = nil) {
        self.id = id
        self.kind = kind
        self.relativePath = relativePath
        self.sha256 = sha256
        self.md5 = md5
        self.crc = crc
        self.size = size
        self.required = required
        self.contentPath = contentPath
        self.conflictOf = conflictOf
    }
}

public struct Manifest: Codable, Equatable, Sendable {
    public var version: Int
    public var itemId: String
    public var revision: Int
    public var files: [ManifestFile]

    public init(version: Int, itemId: String, revision: Int, files: [ManifestFile]) {
        self.version = version
        self.itemId = itemId
        self.revision = revision
        self.files = files
    }
}

public struct UploadSession: Codable, Equatable, Sendable {
    public var id: String
    public var received: Int64
    public var state: String

    public init(id: String, received: Int64, state: String) {
        self.id = id
        self.received = received
        self.state = state
    }
}

public struct UploadComplete: Codable, Equatable, Sendable {
    public var itemId: String
    public var kind: String
    public var displayName: String
    public var relativePath: String
    public var baseRevision: Int

    public init(itemId: String, kind: String, displayName: String, relativePath: String, baseRevision: Int) {
        self.itemId = itemId
        self.kind = kind
        self.displayName = displayName
        self.relativePath = relativePath
        self.baseRevision = baseRevision
    }
}

public struct ChangeEvent: Codable, Equatable, Sendable {
    public var cursor: Int
    public var entityType: String
    public var entityId: String
    public var op: String
    public var libraryId: String?
    public var itemId: String?
    public var sensitive: Bool
    public var recordedAt: String

    public init(cursor: Int, entityType: String, entityId: String, op: String, libraryId: String? = nil, itemId: String? = nil, sensitive: Bool, recordedAt: String) {
        self.cursor = cursor
        self.entityType = entityType
        self.entityId = entityId
        self.op = op
        self.libraryId = libraryId
        self.itemId = itemId
        self.sensitive = sensitive
        self.recordedAt = recordedAt
    }
}

public struct ChangeList: Codable, Equatable, Sendable {
    public var changes: [ChangeEvent]
    public var nextCursor: String

    public init(changes: [ChangeEvent], nextCursor: String) {
        self.changes = changes
        self.nextCursor = nextCursor
    }
}

public struct BootstrapRequest: Codable, Equatable, Sendable {
    public var token: String
    public var username: String
    public var password: String

    public init(token: String, username: String, password: String) {
        self.token = token
        self.username = username
        self.password = password
    }
}

public struct LoginRequest: Codable, Equatable, Sendable {
    public var username: String
    public var password: String

    public init(username: String, password: String) {
        self.username = username
        self.password = password
    }
}

public struct SessionResponse: Codable, Equatable, Sendable {
    public var token: String
    public var tokenType: String
    public var userId: String
    public var expiresAt: String

    public init(token: String, tokenType: String, userId: String, expiresAt: String) {
        self.token = token
        self.tokenType = tokenType
        self.userId = userId
        self.expiresAt = expiresAt
    }
}

public struct UserDraft: Codable, Equatable, Sendable {
    public var username: String
    public var password: String

    public init(username: String, password: String) {
        self.username = username
        self.password = password
    }
}

public struct User: Codable, Equatable, Sendable {
    public var id: String
    public var username: String
    public var isOwner: Bool
    public var createdAt: String

    public init(id: String, username: String, isOwner: Bool, createdAt: String) {
        self.id = id
        self.username = username
        self.isOwner = isOwner
        self.createdAt = createdAt
    }
}

public struct MemberDraft: Codable, Equatable, Sendable {
    public var role: String

    public init(role: String) {
        self.role = role
    }
}

public struct ItemAccessDraft: Codable, Equatable, Sendable {
    public var permission: String

    public init(permission: String) {
        self.permission = permission
    }
}

public struct GuestGrantDraft: Codable, Equatable, Sendable {
    public var libraryId: String
    public var itemId: String?
    public var capabilities: [String]
    public var expiresInSeconds: Int

    public init(libraryId: String, itemId: String? = nil, capabilities: [String], expiresInSeconds: Int) {
        self.libraryId = libraryId
        self.itemId = itemId
        self.capabilities = capabilities
        self.expiresInSeconds = expiresInSeconds
    }
}

public struct GuestGrantCreated: Codable, Equatable, Sendable {
    public var id: String
    public var token: String
    public var expiresAt: String

    public init(id: String, token: String, expiresAt: String) {
        self.id = id
        self.token = token
        self.expiresAt = expiresAt
    }
}

public struct DeviceTokenDraft: Codable, Equatable, Sendable {
    public var name: String
    public var scopes: [String]
    public var expiresInSeconds: Int?

    public init(name: String, scopes: [String], expiresInSeconds: Int? = nil) {
        self.name = name
        self.scopes = scopes
        self.expiresInSeconds = expiresInSeconds
    }
}

public struct DeviceTokenCreated: Codable, Equatable, Sendable {
    public var id: String
    public var token: String
    public var scopes: [String]

    public init(id: String, token: String, scopes: [String]) {
        self.id = id
        self.token = token
        self.scopes = scopes
    }
}

public struct AuditEvent: Codable, Equatable, Sendable {
    public var id: Int
    public var at: String
    public var actorId: String?
    public var action: String
    public var resourceType: String?
    public var resourceId: String?

    public init(id: Int, at: String, actorId: String? = nil, action: String, resourceType: String? = nil, resourceId: String? = nil) {
        self.id = id
        self.at = at
        self.actorId = actorId
        self.action = action
        self.resourceType = resourceType
        self.resourceId = resourceId
    }
}

public struct AuditList: Codable, Equatable, Sendable {
    public var events: [AuditEvent]

    public init(events: [AuditEvent]) {
        self.events = events
    }
}

public struct VirtualEntry: Codable, Equatable, Sendable {
    public var entryId: String
    public var path: String
    public var compressedSize: Int64
    public var uncompressedSize: Int64
    public var method: String
    public var crc: String?

    public init(entryId: String, path: String, compressedSize: Int64, uncompressedSize: Int64, method: String, crc: String? = nil) {
        self.entryId = entryId
        self.path = path
        self.compressedSize = compressedSize
        self.uncompressedSize = uncompressedSize
        self.method = method
        self.crc = crc
    }
}

public struct VirtualEntryList: Codable, Equatable, Sendable {
    public var supported: Bool
    public var entries: [String]
    public var format: String?
    public var items: [VirtualEntry]?

    public init(supported: Bool, entries: [String], format: String? = nil, items: [VirtualEntry]? = nil) {
        self.supported = supported
        self.entries = entries
        self.format = format
        self.items = items
    }
}

public struct AccessPolicy: Codable, Equatable, Sendable {
    public var mode: String
    public var subnets: [String]
    public var applies: Bool
    public var trusted: Bool
    public var manages: Bool

    public init(mode: String, subnets: [String], applies: Bool, trusted: Bool, manages: Bool) {
        self.mode = mode
        self.subnets = subnets
        self.applies = applies
        self.trusted = trusted
        self.manages = manages
    }
}

public struct GuestGrant: Codable, Equatable, Sendable {
    public var id: String
    public var libraryId: String
    public var itemId: String?
    public var capabilities: [String]
    public var expiresAt: String
    public var createdAt: String
    public var revokedAt: String?
    public var createdBy: String?

    public init(id: String, libraryId: String, itemId: String? = nil, capabilities: [String], expiresAt: String, createdAt: String, revokedAt: String? = nil, createdBy: String? = nil) {
        self.id = id
        self.libraryId = libraryId
        self.itemId = itemId
        self.capabilities = capabilities
        self.expiresAt = expiresAt
        self.createdAt = createdAt
        self.revokedAt = revokedAt
        self.createdBy = createdBy
    }
}

public struct GuestGrantList: Codable, Equatable, Sendable {
    public var items: [GuestGrant]

    public init(items: [GuestGrant]) {
        self.items = items
    }
}

public struct RootLibraryAssignment: Codable, Equatable, Sendable {
    public var libraryId: String

    public init(libraryId: String) {
        self.libraryId = libraryId
    }
}

public struct LibraryBrowseEntry: Codable, Equatable, Sendable {
    public var entityType: String
    public var id: String
    public var name: String
    public var libraryId: String?
    public var systemId: String?
    public var canUpload: Bool
    public var canAdopt: Bool
    public var item: Item?
    public var asset: Asset?
    public var source: SourceFile?
    public var parentItem: Item?
    public var previewAsset: Asset?

    public init(entityType: String, id: String, name: String, libraryId: String? = nil, systemId: String? = nil, canUpload: Bool, canAdopt: Bool, item: Item? = nil, asset: Asset? = nil, source: SourceFile? = nil, parentItem: Item? = nil, previewAsset: Asset? = nil) {
        self.entityType = entityType
        self.id = id
        self.name = name
        self.libraryId = libraryId
        self.systemId = systemId
        self.canUpload = canUpload
        self.canAdopt = canAdopt
        self.item = item
        self.asset = asset
        self.source = source
        self.parentItem = parentItem
        self.previewAsset = previewAsset
    }
}

public struct LibraryBrowsePage: Codable, Equatable, Sendable {
    public var items: [LibraryBrowseEntry]
    public var systemCounts: [SystemCount]?
    public var nextCursor: String?

    public init(items: [LibraryBrowseEntry], systemCounts: [SystemCount]? = nil, nextCursor: String? = nil) {
        self.items = items
        self.systemCounts = systemCounts
        self.nextCursor = nextCursor
    }
}

public struct SystemCount: Codable, Equatable, Sendable {
    public var systemId: String
    public var count: Int

    public init(systemId: String, count: Int) {
        self.systemId = systemId
        self.count = count
    }
}

public struct ContentRootSummary: Codable, Equatable, Sendable {
    public var root: ContentRoot
    public var indexedFileCount: Int
    public var scanState: String
    public var lastScanAt: String?
    public var lastCheckAt: String?
    public var online: Bool?
    public var medium: String?

    public init(root: ContentRoot, indexedFileCount: Int, scanState: String, lastScanAt: String? = nil, lastCheckAt: String? = nil, online: Bool? = nil, medium: String? = nil) {
        self.root = root
        self.indexedFileCount = indexedFileCount
        self.scanState = scanState
        self.lastScanAt = lastScanAt
        self.lastCheckAt = lastCheckAt
        self.online = online
        self.medium = medium
    }
}

public struct ContentRootSummaryList: Codable, Equatable, Sendable {
    public var items: [ContentRootSummary]

    public init(items: [ContentRootSummary]) {
        self.items = items
    }
}
