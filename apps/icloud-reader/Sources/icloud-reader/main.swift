import Foundation
import ICloudReaderCore

// Started by the desktop app, which writes one line on standard input:
//   {"origin":"http://127.0.0.1:7878","ticket":"..."}
// The ticket never appears in the arguments, the environment or anything printed here.
// Exit codes: 0 the desktop app closed the pipe, 2 bad start line, 3 the ticket ended (attach
// again), 4 the server stopped answering.

struct Start: Decodable {
  var origin: String
  var ticket: String
}

guard let line = readLine(strippingNewline: true), let data = line.data(using: .utf8),
  let start = try? JSONDecoder().decode(Start.self, from: data),
  let link = HTTPLink(origin: start.origin, ticket: start.ticket)
else {
  FileHandle.standardError.write(Data("icloud-reader: expected a start line on standard input\n".utf8))
  exit(2)
}

// When the desktop app quits, its end of the pipe closes and so does this program.
Thread.detachNewThread {
  while readLine() != nil {}
  exit(0)
}

let reader = Reader(store: CloudKitStore(), link: link) { line in
  FileHandle.standardError.write(Data("icloud-reader: \(line)\n".utf8))
}
switch await reader.run() {
case .ticketEnded: exit(3)
case .serverGone: exit(4)
case .cancelled: exit(0)
}
