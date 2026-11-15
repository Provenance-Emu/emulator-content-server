import Foundation
import Testing
@testable import EmulatorContentClient

struct DevicePairingTests {
    private let secret = String(repeating: "s", count: 43)
    private let token = String(repeating: "t", count: 43)

    @Test func requestFirstUsesMatchingQRAndReturnsReadToken() async throws {
        let client = DevicePairingClient { route, data in
            switch route {
            case "device-pairing/requests":
                return (Data(#"{"id":"request","secret":"\#(secret)","expiresInSeconds":300}"#.utf8), 201)
            case "device-pairing/requests/status":
                let proof = try JSONDecoder().decode(DevicePairingRedemption.self, from: data)
                #expect(proof.secret == secret)
                return (Data(#"{"approved":true}"#.utf8), 200)
            case "device-pairing/requests/complete":
                let proof = try JSONDecoder().decode(DevicePairingCompletion.self, from: data)
                #expect(proof.id == "request")
                #expect(proof.secret == secret)
                #expect(proof.pin == "012345")
                return (Data(#"{"id":"device","token":"\#(token)","scopes":["read"]}"#.utf8), 200)
            default: throw DevicePairingClient.Failure.unavailable
            }
        }
        let request = try await client.start(name: "iFly")
        #expect(request.legacyPIN == nil)
        try await client.waitForApproval(request)
        #expect(throws: DevicePairingClient.Failure.incorrectPIN) { try request.pin(from: "ecs-pair:other:012345") }
        #expect(try await client.redeem(request, code: "ecs-pair:request:012345") == token)
    }

    @Test func fallsBackOnlyForAnUnavailableRequestAPI() async throws {
        let client = DevicePairingClient { route, _ in
            switch route {
            case "device-pairing/requests": return (Data(), 404)
            case "device-pairing":
                return (Data(#"{"id":"legacy","pin":"012345","secret":"\#(secret)","expiresInSeconds":300}"#.utf8), 201)
            case "device-pairing/redeem":
                return (Data(#"{"id":"device","token":"\#(token)","scopes":["read"]}"#.utf8), 200)
            default: throw DevicePairingClient.Failure.unavailable
            }
        }
        let request = try await client.start(name: "iCube")
        #expect(request.legacyPIN == "012345")
        #expect(try await client.waitForLegacyToken(request) == token)
        let busy = DevicePairingClient { route, _ in
            #expect(route == "device-pairing/requests")
            return (Data(), 429)
        }
        await #expect(throws: DevicePairingClient.Failure.response(429)) {
            try await busy.start(name: "Provenance")
        }
    }
}
