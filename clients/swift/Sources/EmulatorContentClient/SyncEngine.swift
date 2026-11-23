import Foundation

/// A way to perform one HTTP request. Production uses `URLSession`; tests supply a scripted one.
public protocol ContentTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// One `URLSession` for the library, available on iOS and tvOS.
///
/// It waits for the network instead of failing at once, opens up to six connections to the
/// server, and keeps answers the server marks as unchanging (covers requested with their
/// `version`) on disk, so a cover is read once per device.
public struct URLSessionTransport: ContentTransport {
    /// Shared so every engine uses the same connections and the same cache.
    public static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.urlCache = URLCache(
            memoryCapacity: 16 * 1024 * 1024, diskCapacity: 256 * 1024 * 1024)
        return URLSession(configuration: configuration)
    }()

    /// Drops every kept answer. Call it when the person signs out or the app switches to
    /// another account, so nothing read under one account is shown under another.
    public static func forgetKeptAnswers() {
        session.configuration.urlCache?.removeAllCachedResponses()
    }

    public init() {}

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw SyncFailure(status: 0, message: "The server did not answer over HTTP")
        }
        return (data, http)
    }
}

/// A request the server refused. The token is never part of the message.
public struct SyncFailure: Error, Equatable, Sendable {
    public let status: Int
    public let message: String

    public init(status: Int, message: String) {
        self.status = status
        self.message = message
    }
}

/// App-neutral calls for the change feed, save uploads, conflict adoption, and resumable downloads.
///
/// Bytes stay with the caller. This type builds the request and reads the JSON, and a download body is
/// left on the response the caller opens, so the same code serves a phone and a television.
public struct ContentSync: Sendable {
    private let baseURL: URL
    private let token: String
    private let transport: any ContentTransport

    public init(baseURL: URL, token: String, transport: any ContentTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.token = token
        self.transport = transport
    }

    /// One page of the feed. `excludeOwnDevice` omits the changes this device token caused.
    public func changes(cursor: String, limit: Int? = nil, excludeOwnDevice: Bool = false) async throws -> ChangeList {
        let request = SyncRequests.changes(
            baseURL: baseURL,
            token: token,
            cursor: cursor,
            limit: limit,
            excludeOwnDevice: excludeOwnDevice
        )
        return try await send(request)
    }

    /// Pages from `cursor` until a page adds nothing, which is how a client catches up.
    public func changePages(from cursor: String, limit: Int? = nil, excludeOwnDevice: Bool = false) -> AsyncThrowingStream<ChangeList, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var cursor = cursor
                do {
                    while !Task.isCancelled {
                        let page = try await changes(cursor: cursor, limit: limit, excludeOwnDevice: excludeOwnDevice)
                        continuation.yield(page)
                        if page.changes.isEmpty || page.nextCursor == cursor {
                            continuation.finish()
                            return
                        }
                        cursor = page.nextCursor
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Makes a conflict copy the live save. The bytes it replaces stay on the server.
    public func adopt(assetId: String) async throws -> Asset {
        try await send(SyncRequests.adopt(baseURL: baseURL, token: token, assetId: assetId))
    }

    /// Starts an upload in a library. Reuse the key when retrying the same creation request.
    public func createUpload(libraryId: String, idempotencyKey: String? = nil) async throws -> UploadSession {
        let request = try SyncRequests.jsonUpload(
            baseURL: baseURL, token: token, path: "/api/v1/uploads",
            body: ["libraryId": libraryId], idempotencyKey: idempotencyKey
        )
        return try await send(request)
    }

    /// Writes a nonempty chunk at the server's committed offset.
    public func uploadChunk(uploadId: String, bytes: Data, offset: Int64, totalBytes: Int64) async throws {
        let byteCount = Int64(bytes.count)
        guard offset >= 0, offset <= totalBytes, byteCount > 0, byteCount <= totalBytes - offset else {
            throw SyncFailure(status: 0, message: "Invalid upload chunk range")
        }
        var request = SyncRequests.authorized(
            baseURL: baseURL, token: token, path: "/api/v1/uploads/\(uploadId)/content"
        )
        request.httpMethod = "PUT"
        request.httpBody = bytes
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue("bytes \(offset)-\(offset + byteCount - 1)/\(totalBytes)", forHTTPHeaderField: "Content-Range")
        _ = try await responseBody(for: request)
    }

    /// Lists the item's files and returns the item revision used to complete an upload.
    public func manifest(itemId: String) async throws -> Manifest {
        try await send(SyncRequests.authorized(baseURL: baseURL, token: token, path: "/api/v1/items/\(itemId)/manifest"))
    }

    /// Commits using the last item revision the caller observed in this server's manifest.
    /// The returned asset can be a conflict copy. Reuse the key and metadata when retrying.
    public func completeUpload(uploadId: String, metadata: UploadComplete, idempotencyKey: String? = nil) async throws -> Asset {
        let request = try SyncRequests.jsonUpload(
            baseURL: baseURL, token: token, path: "/api/v1/uploads/\(uploadId)/complete",
            body: metadata, idempotencyKey: idempotencyKey
        )
        return try await send(request)
    }

    /// The offset the server has committed for an upload, which is where a retry continues.
    public func receivedOffset(uploadId: String) async throws -> Int64 {
        let session: UploadSession = try await send(
            SyncRequests.upload(baseURL: baseURL, token: token, uploadId: uploadId)
        )
        return session.received
    }

    /// The request for an asset from `localBytes` onward. The caller reads the body.
    ///
    /// Pass the asset's SHA-256 as `version` for bytes worth keeping, such as a cover: the
    /// server then marks the answer as unchanging and the session's cache holds it.
    public func contentRequest(
        assetId: String, localBytes: Int64, etag: String?, version: String? = nil
    ) -> URLRequest {
        SyncRequests.content(
            baseURL: baseURL,
            token: token,
            assetId: assetId,
            localBytes: localBytes,
            etag: etag,
            version: version
        )
    }

    /// The request for the saved front cover of a game kept in a server folder. `version` is
    /// the `artworkVersion` from the listing that named the cover.
    public func artworkRequest(sourceId: String, version: String? = nil) -> URLRequest {
        SyncRequests.artwork(baseURL: baseURL, token: token, sourceId: sourceId, version: version)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data = try await responseBody(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func responseBody(for request: URLRequest) async throws -> Data {
        let (data, response) = try await transport.data(for: request)
        guard (200 ..< 300).contains(response.statusCode) else {
            let title = (try? JSONDecoder().decode(ProblemTitle.self, from: data))?.title
            throw SyncFailure(status: response.statusCode, message: title ?? "Content request failed")
        }
        return data
    }
}

/// Request shapes shared by the engine and its tests, so a header can be asserted without a server.
public enum SyncRequests {
    public static func changes(baseURL: URL, token: String, cursor: String, limit: Int?, excludeOwnDevice: Bool) -> URLRequest {
        var parts = ["cursor=\(cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cursor)"]
        if let limit {
            parts.append("limit=\(limit)")
        }
        if excludeOwnDevice {
            parts.append("excludeOwnDevice=1")
        }
        return authorized(baseURL: baseURL, token: token, path: "/api/v1/changes?\(parts.joined(separator: "&"))")
    }

    public static func adopt(baseURL: URL, token: String, assetId: String) -> URLRequest {
        var request = authorized(baseURL: baseURL, token: token, path: "/api/v1/files/\(assetId)/adopt")
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    public static func upload(baseURL: URL, token: String, uploadId: String) -> URLRequest {
        authorized(baseURL: baseURL, token: token, path: "/api/v1/uploads/\(uploadId)")
    }

    public static func content(
        baseURL: URL, token: String, assetId: String, localBytes: Int64, etag: String?,
        version: String? = nil
    ) -> URLRequest {
        var request = authorized(
            baseURL: baseURL, token: token,
            path: "/api/v1/files/\(assetId)/content\(versionQuery(version))")
        let plan = ResumePlan.plan(localBytes: localBytes, totalBytes: nil)
        if let range = plan.range {
            request.setValue(range, forHTTPHeaderField: "Range")
            if let etag {
                request.setValue(etag, forHTTPHeaderField: "If-Range")
            }
        }
        return request
    }

    public static func artwork(baseURL: URL, token: String, sourceId: String, version: String? = nil) -> URLRequest {
        authorized(
            baseURL: baseURL, token: token,
            path: "/api/v1/sources/\(sourceId)/matches/selections/artwork/content\(versionQuery(version))")
    }

    /// The query that names the bytes expected. Anything that is not a SHA-256 is left out.
    private static func versionQuery(_ version: String?) -> String {
        guard let version, version.count == 64, version.allSatisfy(\.isHexDigit) else { return "" }
        return "?v=\(version.lowercased())"
    }

    fileprivate static func jsonUpload<Body: Encodable>(
        baseURL: URL, token: String, path: String, body: Body, idempotencyKey: String?
    ) throws -> URLRequest {
        var request = authorized(baseURL: baseURL, token: token, path: path)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        return request
    }

    fileprivate static func authorized(baseURL: URL, token: String, path: String) -> URLRequest {
        let url = URL(string: path, relativeTo: baseURL) ?? baseURL
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
}

private struct ProblemTitle: Decodable {
    let title: String
}
