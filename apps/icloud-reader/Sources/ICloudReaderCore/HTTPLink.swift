import Foundation

/// Talks to the server on this computer with the reader ticket. The ticket goes in a header,
/// never in an address, and nothing here prints or stores it.
public final class HTTPLink: NSObject, ServerLink, URLSessionTaskDelegate, @unchecked Sendable {
  private let base: URL
  private let ticket: String
  private var session: URLSession!

  /// Fails unless `origin` is plain `http` on a loopback address: the ticket must not leave
  /// this computer.
  public init?(origin: String, ticket: String) {
    guard let url = URL(string: origin), url.scheme == "http", let host = url.host,
      ["127.0.0.1", "localhost", "::1"].contains(host), url.path.isEmpty || url.path == "/",
      url.query == nil, url.user == nil, !ticket.isEmpty
    else { return nil }
    self.base = url.appendingPathComponent("api/v1/icloud/reader")
    self.ticket = ticket
    super.init()
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = [:]
    config.httpCookieStorage = nil
    config.urlCache = nil
    config.timeoutIntervalForRequest = 60
    config.timeoutIntervalForResource = 15 * 60
    self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }

  // A redirect could carry the ticket elsewhere. None is followed.
  public func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest
  ) async -> URLRequest? { nil }

  private func request(_ method: String, _ path: String) -> URLRequest {
    var request = URLRequest(url: base.appendingPathComponent(path))
    request.httpMethod = method
    request.setValue("Bearer \(ticket)", forHTTPHeaderField: "Authorization")
    return request
  }

  private func check(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse else { throw LinkError.unreachable }
    if http.statusCode == 401 { throw LinkError.ticketEnded }
    guard (200..<300).contains(http.statusCode) else { throw LinkError.refused(http.statusCode) }
  }

  private func send(_ request: URLRequest, body: Data? = nil) async throws -> Data {
    do {
      let data: Data
      let response: URLResponse
      if let body {
        (data, response) = try await session.upload(for: request, from: body)
      } else {
        (data, response) = try await session.data(for: request)
      }
      try check(response)
      return data
    } catch let error as LinkError {
      throw error
    } catch {
      throw LinkError.unreachable
    }
  }

  private func post<Body: Encodable>(_ method: String, _ path: String, _ body: Body) async throws {
    var request = request(method, path)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    _ = try await send(request, body: JSONEncoder().encode(body))
  }

  private struct WorkAnswer: Decodable {
    var work: String
    var saves: [WantedSave]?
  }

  public func work() async throws -> Work {
    let data = try await send(request("GET", "work"))
    guard let answer = try? JSONDecoder().decode(WorkAnswer.self, from: data) else {
      throw LinkError.refused(200)
    }
    switch answer.work {
    case "list": return .list
    case "stop": return .stop
    case "fetch": return .fetch(answer.saves ?? [])
    default: return .none
    }
  }

  public func account(_ state: AccountState) async throws {
    try await post("PUT", "account", ["state": state.rawValue])
  }

  private struct Listing: Encodable {
    var saves: [SaveDescription]
    var done: Bool
    var games: [GameDescription]
  }

  public func listing(_ saves: [SaveDescription], done: Bool, games: [GameDescription]) async throws {
    try await post("POST", "listing", Listing(saves: saves, done: done, games: games))
  }

  public func listingFailed(_ reason: ReadFailure) async throws {
    try await post("POST", "listing/failed", ["reason": reason.rawValue])
  }

  public func upload(requestId: String, file: URL) async throws {
    var request = request("PUT", "saves/\(requestId)")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    do {
      let (_, response) = try await session.upload(for: request, fromFile: file)
      try check(response)
    } catch let error as LinkError {
      throw error
    } catch {
      throw LinkError.unreachable
    }
  }

  public func saveFailed(requestId: String, reason: ReadFailure) async throws {
    try await post("POST", "saves/\(requestId)/failed", ["reason": reason.rawValue])
  }
}
