import SwiftUI
import CoreImage.CIFilterBuiltins
#if os(iOS)
import AVFoundation
import VisionKit
#endif

/// A pairing sheet for apps that already know the selected server.
public struct DevicePairingView: View {
    private let client: DevicePairingClient
    private let name: String
    private let legacyApprovalURL: (String) -> URL?
    private let onToken: @MainActor (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var session: DevicePairingClient.Session?
    @State private var operation: Task<Void, Never>?
    @State private var approved = false
    @State private var code = ""
    @State private var error: String?
    @State private var receivedToken: String?
    #if os(iOS)
    @State private var scanning = false
    #endif

    public init(
        client: DevicePairingClient, name: String,
        legacyApprovalURL: @escaping (String) -> URL? = { _ in nil },
        onToken: @escaping @MainActor (String) async throws -> Void
    ) {
        self.client = client
        self.name = name
        self.legacyApprovalURL = legacyApprovalURL
        self.onToken = onToken
    }

    public var body: some View {
        NavigationStack {
            Form {
                if let receivedToken {
                    Button("Retry Connection") { run { try await connect(receivedToken) } }
                        .disabled(operation != nil)
                } else if let pin = session?.legacyPIN {
                    Text("Enter this PIN in Settings → Devices on the server.")
                    Text(pin).font(.title.monospacedDigit())
                    if let url = legacyApprovalURL(pin) {
                        LegacyApprovalCode(value: url.absoluteString)
                        #if !os(tvOS)
                        Link("Approve on the Server", destination: url)
                        #endif
                    }
                } else if approved, let session {
                    Text("Enter the PIN shown in Settings → Devices on the server.")
                    TextField("Pairing PIN", text: $code)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                    Button("Connect") { finish(session, code: code) }
                        .disabled(operation != nil || (try? session.pin(from: code)) == nil)
                    #if os(iOS)
                    if DataScannerViewController.isSupported {
                        Button("Scan QR Code") {
                            run {
                                guard await AVCaptureDevice.requestAccess(for: .video),
                                      DataScannerViewController.isAvailable else {
                                    error = "Camera access is unavailable. Enter the pairing PIN instead."
                                    return
                                }
                                scanning = true
                            }
                        }.disabled(operation != nil)
                    }
                    #endif
                } else if session != nil {
                    Text("Ask the server owner to approve your request in Settings → Devices.")
                }
                if operation != nil { ProgressView() }
                if let error { Text(error).foregroundStyle(.secondary) }
                Button("Cancel", role: .cancel) { dismiss() }
            }
            .navigationTitle("Request Server Access")
        }
        .onAppear { if session == nil && error == nil { start() } }
        .onDisappear {
            operation?.cancel()
            if let session, receivedToken == nil {
                Task { try? await client.cancel(session) }
            }
        }
        #if os(iOS)
        .sheet(isPresented: $scanning) {
            NavigationStack {
                PairingScanner { value in
                    scanning = false
                    guard let session else { return }
                    finish(session, code: value)
                }
                .toolbar { Button("Cancel") { scanning = false } }
            }
        }
        #endif
    }

    private func start() {
        run {
            let awaiting = try await client.start(name: name)
            if Task.isCancelled {
                Task { try? await client.cancel(awaiting) }
                return
            }
            session = awaiting
            if awaiting.legacyPIN == nil {
                try await client.waitForApproval(awaiting)
                approved = true
            } else {
                let token = try await client.waitForLegacyToken(awaiting)
                try await connect(token)
            }
        }
    }

    private func finish(_ session: DevicePairingClient.Session, code: String) {
        run {
            guard let token = try await client.redeem(session, code: code) else { return }
            try await connect(token)
        }
    }

    private func connect(_ token: String) async throws {
        try Task.checkCancellation()
        receivedToken = token
        try await onToken(token)
        dismiss()
    }

    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard operation == nil else { return }
        error = nil
        operation = Task {
            defer { operation = nil }
            do { try await action() }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}

private struct LegacyApprovalCode: View {
    let value: String

    var body: some View {
        let filter = CIFilter.qrCodeGenerator()
        let _ = { filter.message = Data(value.utf8) }()
        if let output = filter.outputImage,
           let image = CIContext().createCGImage(output, from: output.extent) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .frame(width: 150, height: 150)
                .padding(12)
                .background(.white)
                .accessibilityLabel("QR code to open server approval")
        }
    }
}

#if os(iOS)
private struct PairingScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])])
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func dataScanner(_ scanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            guard case .barcode(let barcode) = item, let value = barcode.payloadStringValue else { return }
            scanner.stopScanning()
            onCode(value)
        }
    }
}
#endif
