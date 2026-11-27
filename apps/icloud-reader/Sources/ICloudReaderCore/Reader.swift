import Foundation

public enum ExitReason: Equatable, Sendable {
  case ticketEnded, serverGone, cancelled
}

/// Asks the server what it wants and answers from the store until the ticket ends.
///
/// The server drives: it asks for a listing, then for the bytes of the saves it chose. This loop
/// keeps asking while a download is under way, because asking is how the server knows the reader
/// is still there.
public actor Reader {
  private let store: SaveStore
  private let link: ServerLink
  private let pageSize: Int
  private let retryDelay: Duration
  private var current: Task<Void, Never>?
  /// Takes one short line per failure: what failed and why, never a record's name or contents.
  private let log: @Sendable (String) -> Void

  public init(
    store: SaveStore, link: ServerLink, pageSize: Int = 200, retryDelay: Duration = .seconds(2),
    log: @escaping @Sendable (String) -> Void = { _ in }
  ) {
    self.log = log
    self.store = store
    self.link = link
    self.pageSize = max(1, min(pageSize, 500))
    self.retryDelay = retryDelay
  }

  public func run() async -> ExitReason {
    var misses = 0
    var quiet = 0
    var told: AccountState?
    while !Task.isCancelled {
      do {
        // Tell the server about iCloud at the start and whenever it changes.
        if told == nil || quiet >= 4 {
          let state = await store.account()
          if state != told {
            try await link.account(state)
            told = state
          }
          quiet = 0
        }
        let work = try await link.work()
        misses = 0
        switch work {
        case .none:
          quiet += 1
        case .stop:
          current?.cancel()
        case .list:
          start { await $0.sendListing() }
        case .fetch(let saves):
          start { reader in
            for save in saves where !Task.isCancelled { await reader.send(save) }
          }
        }
      } catch LinkError.ticketEnded {
        current?.cancel()
        return .ticketEnded
      } catch {
        misses += 1
        if misses > 5 {
          current?.cancel()
          return .serverGone
        }
        try? await Task.sleep(for: retryDelay)
      }
    }
    current?.cancel()
    return .cancelled
  }

  /// Runs one piece of work after the one before it, so answers reach the server in order.
  private func start(_ work: @escaping @Sendable (Reader) async -> Void) {
    let before = current
    current = Task { [self] in
      await before?.value
      await work(self)
    }
  }

  private func sendListing() async {
    let link = self.link
    let size = pageSize
    do {
      try await store.list { saves in
        var rest = saves[...]
        while !rest.isEmpty {
          try Task.checkCancellation()
          try await link.listing(Array(rest.prefix(size)), done: false, games: [])
          rest = rest.dropFirst(size)
        }
      }
      try Task.checkCancellation()
      // What the app records about the person's games, so the server can find one by its file
      // and bring its play history. Saves are still listed when this part cannot be read.
      var games: [GameDescription] = []
      do {
        games = try await store.games()
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        log("games not listed: \((error as? ReadFailure)?.rawValue ?? "unexpected")")
      }
      var rest = games[...]
      while rest.count > size {
        try Task.checkCancellation()
        try await link.listing([], done: false, games: Array(rest.prefix(size)))
        rest = rest.dropFirst(size)
      }
      try await link.listing([], done: true, games: Array(rest))
    } catch is CancellationError {
    } catch let failure as ReadFailure {
      log("listing failed: \(failure.rawValue)")
      try? await link.listingFailed(failure)
    } catch {
      // The server already has its answer or cannot be reached; the loop notices either way.
      log("listing failed: \(type(of: error))")
      try? await link.listingFailed(.unexpected)
    }
  }

  /// Reads one save's file, trying again a couple of times when iCloud asks for a pause or the
  /// network drops. Anything else fails at once.
  private func readFile(_ recordName: String) async throws -> URL {
    var tries = 0
    while true {
      do {
        return try await store.file(recordName: recordName)
      } catch let failure as ReadFailure where (failure == .busy || failure == .network) && tries < 2 {
        tries += 1
        log("save read again after: \(failure.rawValue)")
        try await Task.sleep(for: retryDelay)
      }
    }
  }

  private func send(_ wanted: WantedSave) async {
    do {
      let file = try await readFile(wanted.recordName)
      try Task.checkCancellation()
      try await link.upload(requestId: wanted.requestId, file: file)
    } catch is CancellationError {
    } catch let failure as ReadFailure {
      log("save failed: \(failure.rawValue)")
      try? await link.saveFailed(requestId: wanted.requestId, reason: failure)
    } catch {
      log("save failed: \(error)")
      try? await link.saveFailed(requestId: wanted.requestId, reason: .unexpected)
    }
  }
}
