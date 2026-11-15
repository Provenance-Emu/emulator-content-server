import Foundation

/// Pairing transport inherits the app's endpoint, TLS, and redirect policy.
/// The app owns its prompts and saves the resulting token in its existing store.
public struct DevicePairingClient: Sendable {
    public typealias Transport = @Sendable (_ route: String, _ body: Data) async throws -> (Data, Int)

    public enum Failure: Error, Equatable, LocalizedError {
        case unavailable, expired, incorrectPIN, invalidResponse, response(Int)

        public var errorDescription: String? {
            switch self {
            case .unavailable: "Pairing is unavailable on this server."
            case .expired: "This pairing request expired or was dismissed. Request access again."
            case .incorrectPIN: "That code did not match. Enter the PIN shown by the server owner."
            case .invalidResponse: "The server returned an invalid pairing response."
            case .response(let code): "The server could not complete pairing (HTTP \(code))."
            }
        }
    }

    public struct Session: Sendable {
        public let id: String
        public let legacyPIN: String?
        public let expiresInSeconds: Int
        fileprivate let secret: String

        /// Accepts a typed PIN or a QR scanned for this particular request.
        public func pin(from input: String) throws -> String {
            let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
            let prefix = "ecs-pair:\(id):"
            let pin = value.hasPrefix(prefix) ? String(value.dropFirst(prefix.count)) : value
            guard DevicePairingClient.isPIN(pin) else { throw Failure.incorrectPIN }
            return pin
        }
    }

    /// An owner-created code from the server's home page.
    public struct Invitation: Equatable, Sendable {
        public let origin: URL
        fileprivate let id: String
        fileprivate let pin: String

        public init(qrCode: String) throws {
            guard qrCode.utf8.count <= 2048,
                  let code = URLComponents(string: qrCode),
                  code.scheme == "ecs-pair", code.host == "invite", code.path.isEmpty,
                  code.user == nil, code.password == nil, code.port == nil, code.fragment == nil,
                  let items = code.queryItems, items.count == 3,
                  let server = items.first(where: { $0.name == "server" })?.value,
                  let id = items.first(where: { $0.name == "id" })?.value, UUID(uuidString: id) != nil,
                  let pin = items.first(where: { $0.name == "pin" })?.value, DevicePairingClient.isPIN(pin),
                  let url = URL(string: server),
                  let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  ["http", "https"].contains(parts.scheme), parts.host?.isEmpty == false,
                  parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
                  parts.path.isEmpty || parts.path == "/"
            else { throw Failure.invalidResponse }
            self.origin = url
            self.id = id
            self.pin = pin
        }

        public func redeem(deviceName: String, allowHTTP: Bool) async throws -> String {
            let client = try DevicePairingClient(origin: origin, allowHTTP: allowHTTP)
            let claim = DevicePairingInvitationClaim(id: id, pin: pin, name: deviceName)
            let (data, status) = try await client.post("device-pairing/invitations/redeem", claim)
            if status == 404 { throw Failure.expired }
            guard status == 200 else { throw Failure.response(status) }
            return try DevicePairingClient.readToken(from: data)
        }
    }

    private let send: Transport
    private static let requests = "device-pairing/requests"

    public init(transport: @escaping Transport) {
        self.send = transport
    }

    public static func legacyApprovalURL(origin: URL, pin: String) -> URL? {
        guard isPIN(pin), var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
        parts.path = "/ui/"
        parts.queryItems = [URLQueryItem(name: "settings", value: "devices")]
        parts.fragment = "pair=" + pin
        return parts.url
    }

    public init(origin: URL, allowHTTP: Bool) throws {
        guard let parts = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              parts.scheme == "https" || (parts.scheme == "http" && allowHTTP),
              parts.host?.isEmpty == false, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/"
        else { throw URLError(.badURL) }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 15
        let transport = URLSession(configuration: config, delegate: NoPairingRedirects(), delegateQueue: nil)
        self.init { route, body in
            var request = URLRequest(url: origin.appending(path: "api/v1/\(route)"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            let (data, response) = try await transport.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw Failure.invalidResponse }
            return (data, response.statusCode)
        }
    }

    public func start(name: String) async throws -> Session {
        let draft = DevicePairingDraft(name: name)
        let (data, status) = try await post(Self.requests, draft)
        if status == 404 {
            let (data, status) = try await post("device-pairing", draft)
            if status == 404 { throw Failure.unavailable }
            guard status == 201 else { throw Failure.response(status) }
            let reply = try JSONDecoder().decode(DevicePairingChallenge.self, from: data)
            guard Self.isPIN(reply.pin) else { throw Failure.invalidResponse }
            return try session(reply.id, reply.secret, reply.expiresInSeconds, reply.pin)
        }
        guard status == 201 else { throw Failure.response(status) }
        let reply = try JSONDecoder().decode(DevicePairingRequest.self, from: data)
        return try session(reply.id, reply.secret, reply.expiresInSeconds, nil)
    }

    public func isApproved(_ session: Session) async throws -> Bool {
        guard session.legacyPIN == nil else { throw Failure.invalidResponse }
        let (data, status) = try await post("\(Self.requests)/status", proof(session))
        if status == 404 { throw Failure.expired }
        guard status == 200 else { throw Failure.response(status) }
        return try JSONDecoder().decode(DevicePairingApproved.self, from: data).approved
    }

    /// Returns nil while the owner has yet to approve the request.
    public func redeem(_ session: Session, code: String? = nil) async throws -> String? {
        let (data, status): (Data, Int)
        if session.legacyPIN != nil {
            (data, status) = try await post("device-pairing/redeem", proof(session))
        } else {
            let pin = try session.pin(from: code ?? "")
            (data, status) = try await post(
                "\(Self.requests)/complete",
                DevicePairingCompletion(id: session.id, secret: session.secret, pin: pin)
            )
            if status == 400 { throw Failure.incorrectPIN }
        }
        switch status {
        case 202: return nil
        case 404: throw Failure.expired
        case 200:
            return try Self.readToken(from: data)
        default: throw Failure.response(status)
        }
    }

    private static func readToken(from data: Data) throws -> String {
        let result = try JSONDecoder().decode(DeviceTokenCreated.self, from: data)
        guard result.scopes == ["read"], isToken(result.token) else { throw Failure.invalidResponse }
        return result.token
    }

    public func cancel(_ session: Session) async throws {
        guard session.legacyPIN == nil else { return }
        let (_, status) = try await post("\(Self.requests)/cancel", proof(session))
        guard status == 204 || status == 404 else { throw Failure.response(status) }
    }

    public func waitForApproval(_ session: Session) async throws {
        try await poll(session) { try await isApproved(session) ? true : nil }
    }

    public func waitForLegacyToken(_ session: Session) async throws -> String {
        guard session.legacyPIN != nil else { throw Failure.invalidResponse }
        return try await poll(session) { try await redeem(session) }
    }

    @discardableResult
    private func poll<T>(_ session: Session, until attempt: () async throws -> T?) async throws -> T {
        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(session.expiresInSeconds)
        while clock.now < deadline {
            try Task.checkCancellation()
            if let result = try await attempt() { return result }
            try await clock.sleep(until: min(deadline, clock.now + .seconds(3)))
        }
        throw Failure.expired
    }

    private func proof(_ session: Session) -> DevicePairingRedemption {
        DevicePairingRedemption(id: session.id, secret: session.secret)
    }

    private func post(_ route: String, _ body: some Encodable) async throws -> (Data, Int) {
        try await send(route, JSONEncoder().encode(body))
    }

    private func session(_ id: String, _ secret: String, _ expiry: Int, _ pin: String?) throws -> Session {
        guard !id.isEmpty, !id.contains(":"), Self.isToken(secret), (1...300).contains(expiry) else {
            throw Failure.invalidResponse
        }
        return Session(id: id, legacyPIN: pin, expiresInSeconds: expiry, secret: secret)
    }

    private static func isPIN(_ value: String) -> Bool {
        value.utf8.count == 6 && value.utf8.allSatisfy { (48...57).contains($0) }
    }

    private static func isToken(_ value: String) -> Bool {
        value.utf8.count == 43 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
}

private final class NoPairingRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? { nil }
}
