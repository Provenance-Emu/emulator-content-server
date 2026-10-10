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

    public init(`protocol`: ProtocolInfo, minClientVersion: String, features: FeatureFlags, limits: Limits, authentication: [String]) {
        self.`protocol` = `protocol`
        self.minClientVersion = minClientVersion
        self.features = features
        self.limits = limits
        self.authentication = authentication
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

    public init(rangeRequests: Bool, multiRange: Bool, resumableUploads: Bool, changeFeed: Bool, guestGrants: Bool, virtualFormats: [String], webdav: Bool, natTraversal: Bool) {
        self.rangeRequests = rangeRequests
        self.multiRange = multiRange
        self.resumableUploads = resumableUploads
        self.changeFeed = changeFeed
        self.guestGrants = guestGrants
        self.virtualFormats = virtualFormats
        self.webdav = webdav
        self.natTraversal = natTraversal
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
    public var ownerId: String
    public var revision: Int
    public var createdAt: String

    public init(id: String, name: String, ownerId: String, revision: Int, createdAt: String) {
        self.id = id
        self.name = name
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

    public init(id: String, itemId: String, kind: String, displayName: String, relativePath: String, sha256: String, size: Int64, md5: String? = nil, crc: String? = nil, shareable: Bool, revision: Int, createdAt: String, updatedAt: String) {
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

    public init(id: String, kind: String, relativePath: String, sha256: String, md5: String? = nil, crc: String? = nil, size: Int64, required: Bool, contentPath: String) {
        self.id = id
        self.kind = kind
        self.relativePath = relativePath
        self.sha256 = sha256
        self.md5 = md5
        self.crc = crc
        self.size = size
        self.required = required
        self.contentPath = contentPath
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

public struct VirtualEntryList: Codable, Equatable, Sendable {
    public var supported: Bool
    public var entries: [String]

    public init(supported: Bool, entries: [String]) {
        self.supported = supported
        self.entries = entries
    }
}
