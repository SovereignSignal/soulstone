import SwiftUI
import AppKit
import AVFoundation
import Speech
import Carbon
import Darwin

struct Message: Codable, Identifiable { let id: String; let role: String; let text: String }
struct Step: Codable {
    let action: String; let name: String; let count: Int; let item: String?
    var label: String {
        if action == "check_base" { return "Check base" }
        let verb = action == "give" ? "Give you" : action.replacingOccurrences(of:"_",with:" ").capitalized
        let target = count > 0 ? " · \(count) \((item ?? "items").replacingOccurrences(of:"_",with:" "))" : ""
        return verb + (name.isEmpty ? "" : " · " + name) + target
    }
}
struct CompletedStep: Codable { let step: Step }
struct GoalBrief: Codable { let summary: String; let milestones: [String] }
struct GoalCheck: Codable { let description: String; let passed: Bool }
struct GoalVerification: Codable { let verdict: String; let checks: [GoalCheck] }
struct RequestProgress: Codable { let request: String; let status: String; let completed: [CompletedStep]; let pending: [Step]; let blocker: String?; let goal: GoalBrief?; let verification: GoalVerification? }
struct BotTask: Codable { let status: String; let kind: String? }
struct SurvivalThreat: Codable { let name: String; let distance: Double; let risk: String }
struct SurvivalStatus: Codable { let health: Double?; let food: Int?; let saturation: Double?; let oxygen: Int?; let headSubmerged: Bool?; let gameMode: String?; let difficulty: String?; let nearbyThreats: [SurvivalThreat] }
struct MicrosoftLogin: Codable { let code: String; let url: String; let expiresAt: Double }
struct SurvivalSessionBrief: Codable { let status: String; let mode: String; let reason: String; let completedCycles: Int; let days: Int }
struct Snapshot: Codable {
    let survivalSession: SurvivalSessionBrief?
    let authentication: MicrosoftLogin?
    let translation: String?; let botName: String?; let minecraftVersion: String?; let connectionIssue: String?; let worldId: String?
    let phase: String; let connected: Bool; let owner: String; let ownerVisible: Bool
    let dead: Bool?; let respawning: Bool?
    let inventory: [String: Int]; let task: BotTask?; let plan: [Step]; let stepIndex: Int
    let activity: String; let messages: [Message]; let model: String; let modelReady: Bool?; let providerKind: String?; let modelLabel: String?
    let survival: SurvivalStatus?
    let requestProgress: RequestProgress?; let canResume: Bool?; let experienceCount: Int?
}
struct APIInfo: Codable { let url: String; let token: String; let pid: Int }
struct LaunchConfig: Codable { let workspace: String; let node: String }

@MainActor final class CompanionModel: NSObject, ObservableObject {
    @Published var needsSetup = false
    var isPortable: Bool { Bundle.main.url(forResource:"development",withExtension:"json") == nil }
    var hasLabConfiguration: Bool {
        guard let path = Bundle.main.url(forResource:"development",withExtension:"json"),
              let data = try? Data(contentsOf:path),
              let config = try? JSONDecoder().decode(LaunchConfig.self,from:data) else { return false }
        return FileManager.default.fileExists(atPath:URL(fileURLWithPath:config.workspace).appendingPathComponent("harness/.env").path)
    }
    var usingLab: Bool { hasLabConfiguration && UserDefaults.standard.string(forKey:"worldSource") != "saved" }
    @Published var worldName = "Minecraft"
    @Published var snapshot: Snapshot?
    @Published var draft = ""
    @Published var error = ""
    @Published var listening = false
    @Published var voiceOn = UserDefaults.standard.object(forKey: "voiceReplies") as? Bool ?? false
    @Published var voiceDraft = ""
    @Published var linking = true
    @Published private(set) var manuallyDisconnected = UserDefaults.standard.bool(forKey:"agentDisconnected")
    private var info: APIInfo?
    private var backend: Process?
    private var timer: Timer?
    private var polling = false
    private var connecting = false
    private var switching = false
    private var sessionEpoch = 0
    private var expectedWorldID: String?
    private var endpoint: URL?
    private var serviceLost = false
    private let clientID = UUID().uuidString
    private var sequence = 0
    private var seen = Set<String>()
    private var initialized = false
    private let speaker = AVSpeechSynthesizer()
    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognition: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var voiceID = UUID()
    private var tapInstalled = false
    private var requestingVoice = false
    private var voiceTimeout: Timer?
    private var hotkey: EventHotKeyRef?
    private var hotkeyHandler: EventHandlerRef?

    override init() {
        super.init()
        if manuallyDisconnected {
            linking = false
            worldName = usingLab ? "Minecraft lab" : ((try? WorldSetup.read())?.displayName ?? "Minecraft")
        } else { Task { await connect() } }
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return noErr }
            let model = Unmanaged<CompanionModel>.fromOpaque(context).takeUnretainedValue()
            Task { @MainActor in model.toggleTalk() }
            return noErr
        }, 1, &event, context, &hotkeyHandler)
        let id = EventHotKeyID(signature: OSType(0x4D435654), id: 1)
        let result = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &hotkey)
        if result != noErr { error = "Voice shortcut unavailable. Use the Talk button." }
    }
    private func readEndpoint() -> APIInfo? {
        guard let endpoint, let data = try? Data(contentsOf:endpoint),
              let candidate = try? JSONDecoder().decode(APIInfo.self,from:data),
              let url = URL(string:candidate.url), url.scheme == "http", url.host == "127.0.0.1",
              url.port != nil, url.user == nil, url.password == nil, url.path.isEmpty,
              candidate.pid > 0, candidate.pid <= Int(Int32.max), candidate.token.count >= 32 else { return nil }
        return candidate
    }
    func connect() async {
        guard !connecting else { return }; connecting = true; linking = true
        manuallyDisconnected = false; UserDefaults.standard.set(false,forKey:"agentDisconnected")
        defer { connecting = false }
        var launched: Process?
        do {
            let root: URL
            let node: URL
            let arguments: [String]
            var environment: [String:String]? = nil
            if usingLab, let path = Bundle.main.url(forResource:"development",withExtension:"json") {
                let config = try JSONDecoder().decode(LaunchConfig.self,from:Data(contentsOf:path))
                root = URL(fileURLWithPath:config.workspace).appendingPathComponent("harness")
                node = URL(fileURLWithPath:config.node)
                arguments = ["--env-file-if-exists=.env", "src/companion/server.js"]
                worldName = "Minecraft lab"
                expectedWorldID = nil
            } else {
                guard FileManager.default.fileExists(atPath:WorldSetup.file.path) else {
                    needsSetup = true; linking = false; return
                }
                let setup = try WorldSetup.read()
                if setup.auth == "microsoft" {
                    guard let id = setup.minecraftAccountId else { needsSetup = true; linking = false; error = "Open Agent connection → Change world or account to link a Minecraft account."; return }
                    do { _ = try await accountRequest(action:"check",id:id) }
                    catch { needsSetup = true; linking = false; self.error = error.localizedDescription; return }
                }
                root = setup.worldDirectory
                let runtime = try runtimePaths()
                node = runtime.node
                arguments = [runtime.source.appendingPathComponent("server.js").path]
                worldName = setup.displayName
                expectedWorldID = setup.id
                try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                environment = cleanLaunchEnvironment()
                environment?["MC_SETUP_FILE"] = setup.profileFile.path
                environment?["MC_ACCOUNTS_DIR"] = WorldSetup.directory.appendingPathComponent("accounts").path
            }
            endpoint = root.appendingPathComponent("state/companion-api.json")
            beginPolling()
            if await poll() {
                if snapshot?.connected == false { await post("/reconnect") }
                return
            }
            // An unresponsive process may still be starting. Do not create a
            // second Minecraft session beside it.
            if let existing = readEndpoint(), kill(Int32(existing.pid),0) == 0 {
                throw NSError(domain:"The bot service is running but has not responded. Open Agent connection to retry.",code:2)
            }
            let p = Process(); p.executableURL = node
            p.arguments = arguments
            if let environment { p.environment = environment }
            p.currentDirectoryURL = root
            let logURL = root.appendingPathComponent("state/companion-service.log")
            try FileManager.default.createDirectory(at:root.appendingPathComponent("state"),withIntermediateDirectories:true)
            if !FileManager.default.fileExists(atPath:logURL.path) { FileManager.default.createFile(atPath:logURL.path,contents:nil,attributes:[.posixPermissions:0o600]) }
            let log = try FileHandle(forWritingTo:logURL); try log.seekToEnd()
            p.standardOutput = log; p.standardError = log
            try p.run(); try log.close(); backend = p; launched = p
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline {
                try await Task.sleep(nanoseconds:250_000_000)
                if !p.isRunning { throw NSError(domain:"Bot service could not start. See companion-service.log.",code:2) }
                if let candidate = readEndpoint(), candidate.pid == Int(p.processIdentifier), await poll() { return }
            }
            throw NSError(domain:"Bot startup timed out. Open Agent connection to retry.",code:3)
        } catch {
            if let launched, launched.isRunning { launched.terminate() }
            if launched != nil { backend = nil }
            self.error = error.localizedDescription; linking = false
        }
    }
    private func cleanLaunchEnvironment() -> [String:String] {
        let allowed = ["HOME","USER","LOGNAME","PATH","TMPDIR","LANG","LC_ALL","SSL_CERT_FILE"]
        return ProcessInfo.processInfo.environment.filter { allowed.contains($0.key) }
    }
    private func runtimePaths() throws -> (node:URL, source:URL) {
        if let path = Bundle.main.url(forResource:"development",withExtension:"json") {
            let config = try JSONDecoder().decode(LaunchConfig.self,from:Data(contentsOf:path))
            return (URL(fileURLWithPath:config.node),URL(fileURLWithPath:config.workspace).appendingPathComponent("harness/src/companion"))
        }
        guard let resources = Bundle.main.resourceURL else { throw CocoaError(.fileNoSuchFile) }
        return (resources.appendingPathComponent("runtime/node"),resources.appendingPathComponent("runtime/harness/src/companion"))
    }
    private func profileTool(_ setup:WorldSetup, check:Bool = false, saveOnly:Bool = false) async throws -> Data {
        try await runProfileTool(try JSONEncoder().encode(setup),options:check ? ["--check"] : saveOnly ? ["--save-profile"] : [])
    }
    func discoverModels(kind:String,url:String = "",key:String = "") async throws -> DiscoveredModels {
        let input = try JSONSerialization.data(withJSONObject:["kind":kind,"url":url,"apiKey":key])
        return try JSONDecoder().decode(DiscoveredModels.self,from:await runProfileTool(input,options:["--models"],timeout:30))
    }
    func accountInput(action:String,id:String? = nil) throws -> Data {
        var value = ["action":action,"root":WorldSetup.directory.appendingPathComponent("accounts").path]
        if let id { value["id"] = id }
        return try JSONSerialization.data(withJSONObject:value)
    }
    func accountProcess() throws -> Process {
        let runtime = try runtimePaths(), p = Process()
        p.executableURL = runtime.node; p.arguments = [runtime.source.appendingPathComponent("account-tool.js").path]
        p.currentDirectoryURL = runtime.source
        p.environment = cleanLaunchEnvironment()
        return p
    }
    func accountRequest(action:String,id:String? = nil) async throws -> AccountEvent {
        let p = try accountProcess(), data = try accountInput(action:action,id:id)
        return try await Task.detached {
            let input = Pipe(), output = Pipe(); p.standardInput = input; p.standardOutput = output; p.standardError = FileHandle.nullDevice
            try p.run()
            // List/check/remove are local operations, not the interactive sign-in.
            // Bound a blocked child startup or filesystem read as well as auth errors.
            DispatchQueue.global().asyncAfter(deadline:.now()+10) { if p.isRunning { p.terminate() } }
            DispatchQueue.global().asyncAfter(deadline:.now()+13) { if p.isRunning { kill(p.processIdentifier,SIGKILL) } }
            try input.fileHandleForWriting.write(contentsOf:data); try input.fileHandleForWriting.close()
            let result = try output.fileHandleForReading.readToEnd() ?? Data(); p.waitUntilExit()
            guard !result.isEmpty else { throw NSError(domain:"SoulStone.Accounts",code:2,userInfo:[NSLocalizedDescriptionKey:"Account lookup could not finish. Close this menu and open Agent connection to retry."]) }
            let event = try JSONDecoder().decode(AccountEvent.self,from:result)
            guard event.type != "error" else { throw NSError(domain:"SoulStone.Accounts",code:1,userInfo:[NSLocalizedDescriptionKey:event.message ?? "Account check failed. Link the account again."]) }
            return event
        }.value
    }
    func disconnectAccount(_ id:String) async throws {
        if !usingLab, let setup = try? WorldSetup.read(), setup.minecraftAccountId == id {
            try await disconnectAgent()
        }
    }
    func disconnectAgent() async throws {
        guard !connecting && !switching else {
            throw NSError(domain:"SoulStone.Connection",code:1,userInfo:[NSLocalizedDescriptionKey:"Wait for the current connection change to finish."])
        }
        switching = true; linking = true
        defer { switching = false; linking = false }
        do {
            try await detachWorld()
            manuallyDisconnected = true; UserDefaults.standard.set(true,forKey:"agentDisconnected")
            error = ""
        } catch { beginPolling(); throw error }
    }
    private func runProfileTool(_ inputData:Data,options:[String],timeout:Double = 8) async throws -> Data {
        let runtime = try runtimePaths(), environment = cleanLaunchEnvironment()
        return try await Task.detached {
            let p = Process(); p.executableURL = runtime.node
            p.arguments = [runtime.source.appendingPathComponent("validate-setup.js").path] + options
            p.currentDirectoryURL = runtime.source
            p.environment = environment
            let input = Pipe(), output = Pipe(); p.standardInput = input; p.standardOutput = output; p.standardError = output
            try p.run()
            DispatchQueue.global().asyncAfter(deadline:.now()+timeout) { if p.isRunning { p.terminate() } }
            try input.fileHandleForWriting.write(contentsOf:inputData); try input.fileHandleForWriting.close()
            let data = try output.fileHandleForReading.readToEnd() ?? Data(); p.waitUntilExit()
            guard p.terminationStatus == 0 else {
                let message = String(data:data,encoding:.utf8)?.trimmingCharacters(in:.whitespacesAndNewlines)
                throw NSError(domain:"SoulStone.Setup",code:1,userInfo:[NSLocalizedDescriptionKey:message?.isEmpty == false ? message! : "Connection check timed out. Check the address and required network access."])
            }
            return data
        }.value
    }
    func checkConnection(_ setup:WorldSetup) async throws -> ConnectionCheck {
        try JSONDecoder().decode(ConnectionCheck.self,from:await profileTool(setup,check:true))
    }
    private func processExists(_ pid:Int) -> Bool { kill(Int32(pid),0) == 0 || errno == EPERM }
    private func stopService(at file:URL) async throws {
        guard FileManager.default.fileExists(atPath:file.path) else { return }
        let candidate = try JSONDecoder().decode(APIInfo.self,from:Data(contentsOf:file))
        guard candidate.pid > 0, candidate.pid <= Int(Int32.max), candidate.token.count >= 32,
              let base = URL(string:candidate.url),base.scheme == "http",base.host == "127.0.0.1",base.port != nil,
              base.user == nil,base.password == nil,base.path.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
        guard processExists(candidate.pid) else { return }
        var request = URLRequest(url:base.appendingPathComponent("shutdown")); request.httpMethod = "POST"; request.httpBody = Data("{}".utf8); request.timeoutInterval = 4
        request.setValue("Bearer \(candidate.token)",forHTTPHeaderField:"Authorization")
        do {
            let (_,response) = try await URLSession.shared.data(for:request)
            guard (response as? HTTPURLResponse)?.statusCode == 202 else {
                throw NSError(domain:"SoulStone.Worlds",code:1,userInfo:[NSLocalizedDescriptionKey:"The existing service could not close safely. Restart that SoulStone service before switching worlds."])
            }
        } catch {
            if let backend,backend.isRunning,Int(backend.processIdentifier) == candidate.pid { backend.terminate() }
            else if processExists(candidate.pid) { throw error }
        }
        let deadline = Date().addingTimeInterval(6)
        while processExists(candidate.pid) {
            guard Date() < deadline else { throw NSError(domain:"SoulStone.Worlds",code:1,userInfo:[NSLocalizedDescriptionKey:"The old bot is still disconnecting. Retry switching once it closes."]) }
            try await Task.sleep(nanoseconds:50_000_000)
        }
    }
    private func detachWorld() async throws {
        cancelVoice(); draft = ""; speaker.stopSpeaking(at:.immediate)
        timer?.invalidate(); timer = nil; sessionEpoch += 1
        if let endpoint { try await stopService(at:endpoint) }
        backend = nil; info = nil; endpoint = nil; snapshot = nil; initialized = false; serviceLost = false
    }
    func saveConnection(_ setup: WorldSetup) async throws -> WorldSetup {
        guard !connecting && !switching else { throw NSError(domain:"SoulStone.Connection",code:1,userInfo:[NSLocalizedDescriptionKey:"Wait for the current connection change to finish."]) }
        switching = true
        defer { switching = false; linking = false }
        var value = try JSONDecoder().decode(WorldSetup.self,from:await profileTool(setup,saveOnly:true)); value.name = setup.name
        if !usingLab, let current = try? WorldSetup.read(), current.id == value.id, current != value {
            do { try await detachWorld() } catch { beginPolling(); throw error }
            manuallyDisconnected = true; UserDefaults.standard.set(true,forKey:"agentDisconnected")
            worldName = value.displayName
        }
        return try WorldSetup.store.save(value,activate:false)
    }
    func removeConnection(_ setup: WorldSetup) async throws {
        guard !connecting && !switching else { throw NSError(domain:"SoulStone.Connection",code:1,userInfo:[NSLocalizedDescriptionKey:"Wait for the current connection change to finish."]) }
        if !usingLab, (try? WorldSetup.read())?.id == setup.id {
            try await disconnectAgent()
            worldName = "No connection selected"
        }
        // Also close a detached service belonging to this saved entry.
        try await stopService(at:setup.worldDirectory.appendingPathComponent("state/companion-api.json"))
        try WorldSetup.store.remove(setup.id)
    }
    func configure(_ setup: WorldSetup) async throws {
        guard !connecting && !switching else { throw NSError(domain:"SoulStone.Connection",code:1,userInfo:[NSLocalizedDescriptionKey:"Wait for the current connection change to finish."]) }; switching = true
        defer { switching = false; beginPolling() }
        var value = try JSONDecoder().decode(WorldSetup.self,from:await profileTool(setup)); value.name = setup.name
        if value.auth == "microsoft" {
            guard let id = value.minecraftAccountId else { throw NSError(domain:"SoulStone.Accounts",code:1,userInfo:[NSLocalizedDescriptionKey:"Link a Minecraft account in World connections before connecting."]) }
            _ = try await accountRequest(action:"check",id:id)
        }
        let connection = try await checkConnection(value)
        guard connection.status == "reachable" else { throw NSError(domain:"SoulStone.Worlds",code:1,userInfo:[NSLocalizedDescriptionKey:connection.message]) }
        try await detachWorld()
        // A previously attached service for the destination may also be alive.
        // Stop it before editing its connection details or launching another.
        try await stopService(at:value.worldDirectory.appendingPathComponent("state/companion-api.json"))
        try WorldSetup.store.save(value)
        UserDefaults.standard.set("saved",forKey:"worldSource")
        needsSetup = false; error = ""
        await connect()
    }
    func connectToLab() async throws {
        guard !isPortable && !connecting && !switching else { return }; switching = true
        defer { switching = false; beginPolling() }
        try await detachWorld()
        UserDefaults.standard.set("lab",forKey:"worldSource")
        needsSetup = false; error = ""
        await connect()
    }
    private func beginPolling() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval:1,repeats:true) { [weak self] _ in Task { @MainActor in _ = await self?.poll() } }
    }
    func makeRequest(_ path:String, method:String = "GET", body:[String:String]? = nil) throws -> URLRequest {
        guard let info, let url = URL(string:info.url + path) else { throw NSError(domain:"Bot service disconnected",code:4) }
        var r = URLRequest(url:url); r.httpMethod = method; r.timeoutInterval = 4
        r.setValue("Bearer \(info.token)",forHTTPHeaderField:"Authorization")
        if let body { r.setValue("application/json",forHTTPHeaderField:"Content-Type"); r.httpBody = try JSONEncoder().encode(body) }
        return r
    }
    private func poll() async -> Bool {
        if polling { return false }; polling = true; defer { polling = false }
        let epoch = sessionEpoch
        let previousPID = info?.pid
        if let candidate = readEndpoint() { info = candidate }
        do {
            let (data,response) = try await URLSession.shared.data(for:makeRequest("/state"))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain:"Service unavailable",code:4) }
            let value = try JSONDecoder().decode(Snapshot.self,from:data)
            guard epoch == sessionEpoch else { return false }
            guard value.worldId == expectedWorldID else { throw NSError(domain:"SoulStone.Worlds",code:1,userInfo:[NSLocalizedDescriptionKey:"The service belongs to a different world profile. Close that service before reconnecting."]) }
            if initialized && previousPID == info?.pid && !serviceLost {
                for m in value.messages where !seen.contains(m.id) && m.role == "assistant" { speak(m.text) }
            }
            let reattached = !initialized || previousPID != info?.pid || serviceLost
            initialized = true; seen = Set(value.messages.map(\.id)); snapshot = value; linking = false
            if serviceLost { error = "" }; serviceLost = false
            if reattached { Task { await restoreModelKey() } }
            return true
        } catch {
            guard epoch == sessionEpoch else { return false }
            snapshot = nil; serviceLost = true
            if initialized { self.error = "Service disconnected. Open Agent connection and choose Connect agent." }
            return false
        }
    }
    private func post(_ path:String,body:[String:String] = [:]) async {
        if switching && path != "/stop" { return }
        let epoch = sessionEpoch
        sequence += 1; var envelope = body
        envelope["client"] = clientID; envelope["sequence"] = String(sequence)
        do {
            let (_,r) = try await URLSession.shared.data(for:makeRequest(path,method:"POST",body:envelope))
            guard let status = (r as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else { throw NSError(domain:"The bot could not accept this request",code:5) }
            if epoch == sessionEpoch { _ = await poll() }
        } catch { if epoch == sessionEpoch { self.error = error.localizedDescription } }
    }
    func send() {
        guard !switching else { return }
        let text = draft.trimmingCharacters(in:.whitespacesAndNewlines); guard !text.isEmpty else { return }
        if text.range(of: "^(please )?(stop|stop now|stop bot|cancel|hold on|stop everything|wait)[.!]?$", options: [.regularExpression, .caseInsensitive]) != nil {
            draft = ""; stop(); return
        }
        cancelVoice(); draft = ""; error = ""; speaker.stopSpeaking(at:.immediate)
        Task { await post("/message",body:["text":text]) }
    }
    func resume() { cancelVoice(); speaker.stopSpeaking(at:.immediate); Task { await post("/resume") } }
    func respawn() { cancelVoice(); speaker.stopSpeaking(at:.immediate); Task { await post("/respawn") } }
    func stop() { cancelVoice(); speaker.stopSpeaking(at:.immediate); Task { await post("/stop") } }
    func speak(_ text:String) {
        guard voiceOn && !listening else { return }
        let utterance = AVSpeechUtterance(string:text)
        utterance.voice = AVSpeechSynthesisVoice(language:"en-US"); utterance.rate = 0.5
        speaker.speak(utterance)
    }
    func muteChanged() { UserDefaults.standard.set(voiceOn, forKey: "voiceReplies"); if !voiceOn { speaker.stopSpeaking(at:.immediate) } }
    func toggleTalk() {
        guard !switching else { return }
        if listening { finishVoice(); return }
        guard !requestingVoice else { return }; requestingVoice = true
        let permissionID = voiceID
        Task {
            defer { requestingVoice = false }
            let permission = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning:$0) } }
            guard permission == .authorized else { error = "Enable Speech Recognition for SoulStone in System Settings. Text input still works."; return }
            let mic = await AVCaptureDevice.requestAccess(for:.audio)
            guard permissionID == voiceID else { return }
            guard mic else { error = "Enable microphone access for SoulStone in System Settings."; return }
            do { try startVoice() } catch { self.error = error.localizedDescription; cancelVoice() }
        }
    }
    private func startVoice() throws {
        cancelVoice(); speaker.stopSpeaking(at:.immediate)
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { throw NSError(domain:"On-device English speech recognition is unavailable. Enable English Dictation in macOS, or use text input.",code:6) }
        error = ""; voiceDraft = ""; listening = true; voiceID = UUID(); let id = voiceID
        let r = SFSpeechAudioBufferRecognitionRequest(); r.shouldReportPartialResults = true; r.requiresOnDeviceRecognition = true
        r.contextualStrings = ["Minecraft", "oak logs", "follow me", "come back", "Sovereign Signal"]
        request = r
        let input = engine.inputNode; let format = input.outputFormat(forBus:0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain:"No microphone input available",code:7) }
        input.installTap(onBus:0,bufferSize:1024,format:format) { buffer,_ in r.append(buffer) }; tapInstalled = true
        recognition = recognizer.recognitionTask(with:r) { [weak self] result,error in
            Task { @MainActor in
                guard let self, self.voiceID == id else { return }
                if let result { self.voiceDraft = result.bestTranscription.formattedString }
                if let error, self.listening { self.error = error.localizedDescription; self.cancelVoice() }
            }
        }
        engine.prepare(); try engine.start()
        voiceTimeout = Timer.scheduledTimer(withTimeInterval:45,repeats:false) { [weak self] _ in Task { @MainActor in self?.finishVoice() } }
    }
    private func finishVoice() {
        let id = voiceID
        listening = false; engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus:0); tapInstalled = false }
        request?.endAudio(); voiceTimeout?.invalidate()
        Task {
            try? await Task.sleep(nanoseconds:700_000_000)
            guard voiceID == id else { return }
            let text = voiceDraft.trimmingCharacters(in:.whitespacesAndNewlines)
            cancelVoice()
            if text.isEmpty { error = "I did not hear any words. Try again or type below."; return }
            draft = text; send()
        }
    }
    private func cancelVoice() {
        voiceID = UUID(); voiceTimeout?.invalidate(); voiceTimeout = nil
        engine.stop(); if tapInstalled { engine.inputNode.removeTap(onBus:0); tapInstalled = false }
        request?.endAudio(); recognition?.cancel(); recognition = nil; request = nil; listening = false
    }
    func shutdown() {
        timer?.invalidate(); cancelVoice(); speaker.stopSpeaking(at:.immediate)
        if let backend, backend.isRunning { backend.terminate() }
        if let hotkey { UnregisterEventHotKey(hotkey) }
        if let hotkeyHandler { RemoveEventHandler(hotkeyHandler) }
    }
}

struct CompanionView: View {
    @ObservedObject var model: CompanionModel
    @State private var showModels = false
    @State private var showConnection = false
    private let green = Color(red:0.47,green:0.85,blue:0.96)
    private var modelStatus: String {
        guard model.snapshot != nil else { return "Connect to the service to view the selected model." }
        let s=model.snapshot
        let subscription = ["codex","claude"].contains(s?.providerKind ?? "")
        let status = subscription ? (s?.modelReady == true ? "Subscription signed in" : "CLI sign-in needed") : s?.providerKind == "local" ? (s?.modelReady == true ? "Ready" : "Starting / offline") : (s?.modelReady == true ? "API key configured" : "API key needed")
        return [s?.modelLabel ?? "Local model", s?.model ?? "", status + " · local voice"].joined(separator:"\n")
    }
    var body: some View {
        GeometryReader { geometry in
        VStack(spacing:0) {
            HStack(alignment:.center,spacing:14) {
                BrandArtwork(name:"SoulLantern").frame(width:54,height:54).clipShape(RoundedRectangle(cornerRadius:14))
                VStack(alignment:.leading,spacing:4) {
                    Text("SoulStone").font(.system(size:21,weight:.heavy,design:.rounded)).tracking(2)
                    HStack(spacing:6) { Circle().fill(model.snapshot?.connected == true ? green : .orange).frame(width:7,height:7)
                        Text(model.snapshot?.dead == true ? "\(model.snapshot?.botName ?? "Teammate") · died" : model.snapshot?.connected == true ? "\(model.snapshot?.botName ?? "Teammate") · connected" : model.linking ? "Connecting…" : "Bot disconnected").font(.caption).foregroundStyle(.secondary) }
                    Text(model.worldName + (model.snapshot?.minecraftVersion.map { " · Java " + $0 } ?? "")).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Button { showConnection.toggle() } label: {
                    HStack(spacing:6) { Image(systemName:"network"); Text("Agent connection"); Image(systemName:"chevron.down").font(.caption2) }
                }.help("Choose a world, manage the Minecraft account, or connect and disconnect your agent")
                    .popover(isPresented:$showConnection,arrowEdge:.bottom) {
                        AgentConnectionView(companion:model,close:{showConnection = false},manageWorlds:{
                            showConnection = false; model.needsSetup = true
                        })
                    }
                Button("Models") { showModels = true }
                Toggle("Voice replies",isOn:$model.voiceOn).toggleStyle(.switch).controlSize(.small).onChange(of:model.voiceOn){ model.muteChanged() }
            }.padding(.horizontal,24).padding(.vertical,16)
            if let translation = model.snapshot?.translation { Text(translation).font(.caption2).foregroundStyle(.secondary) }
            Divider()
            HStack(alignment:.top,spacing:0) {
                ScrollView {
                LazyVStack(alignment:.leading,spacing:18) {
                    Text("YOUR PARTY").font(.system(size:10,weight:.bold)).tracking(1.5).foregroundStyle(green)
                    Label(model.snapshot?.owner ?? "Player",systemImage:"person.fill").font(.headline)
                    Text(model.snapshot?.botName?.lowercased() == model.snapshot?.owner.lowercased() && model.snapshot?.botName != nil ? "SoulStone is playing as this account" : model.snapshot?.ownerVisible == true ? "You are in view" : "Waiting to see you in the world").font(.caption).foregroundStyle(.secondary)
                    Divider()
                    if let survival = model.snapshot?.survival, model.snapshot?.connected == true {
                        Text("SURVIVAL").font(.system(size:10,weight:.bold)).tracking(1.5).foregroundStyle(.secondary)
                        VitalsView(health:survival.health, food:survival.food)
                        if survival.headSubmerged == true || (survival.oxygen ?? 20) < 20 { Text("Air: \(survival.oxygen.map(String.init) ?? "unknown") / 20").font(.caption).foregroundStyle(.orange) }
                        Text("\(survival.gameMode?.capitalized ?? "Unknown mode") · \(survival.difficulty?.capitalized ?? "Unknown difficulty")").font(.caption2).foregroundStyle(.secondary)
                        if survival.nearbyThreats.isEmpty {
                            Text("No potential threats observed within 24 blocks").font(.caption2).foregroundStyle(.secondary)
                        } else {
                            VStack(alignment:.leading,spacing:6) {
                            ForEach(Array(survival.nearbyThreats.prefix(3).enumerated()), id: \.offset) { _, threat in
                                Text("\(threat.name.replacingOccurrences(of: "_", with: " ")) · \(String(format: "%.1f", threat.distance)) blocks").font(.caption2).foregroundStyle(.orange)
                            }
                            }
                        }
                        Divider()
                    }
                    Text("MISSION").font(.system(size:10,weight:.bold)).tracking(1.5).foregroundStyle(.secondary)
                    Text(model.snapshot == nil ? "Waiting for service" : model.snapshot?.phase == "blocked" ? "Task blocked" : model.snapshot?.phase == "thinking" ? "Thinking…" : model.snapshot?.activity.isEmpty == false ? model.snapshot!.activity.capitalized : model.snapshot?.task?.kind == "follow" && model.snapshot?.task?.status == "running" ? "Following you" : "Ready when you are").font(.headline)
                    if let s = model.snapshot {
                        if s.canResume == true { Button("Resume task") { model.resume() } }
                        if let progress = s.requestProgress {
                            Text(progress.request).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                            if let goal = progress.goal {
                                Text(goal.summary).font(.caption).lineLimit(5)
                                DisclosureGroup("Milestones") {
                                    ForEach(Array(goal.milestones.enumerated()), id: \.offset) { _, milestone in
                                        Text(milestone).font(.caption2).frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }.font(.caption)
                            }
                            if let verification = progress.verification {
                                Text(verification.verdict == "passed" ? "Goal checks passed" : verification.verdict == "needs_review" ? "Needs your review" : "Checking goal requirements").font(.caption).foregroundStyle(verification.verdict == "passed" ? green : .secondary)
                                VStack(alignment:.leading,spacing:8) {
                                ForEach(Array(verification.checks.enumerated()), id: \.offset) { _, check in
                                    Label(check.description, systemImage: check.passed ? "checkmark.circle.fill" : "circle").font(.caption2).foregroundStyle(check.passed ? green : .secondary)
                                }
                                }
                            }
                            if !progress.completed.isEmpty {
                                Text("\(progress.completed.count) actions recorded").font(.caption2).foregroundStyle(green)
                            }
                            if let blocker = progress.blocker, ["blocked","interrupted","paused"].contains(progress.status) {
                                Text(blocker).font(.caption).foregroundStyle(.orange).lineLimit(4)
                            }
                        }
                        VStack(alignment:.leading,spacing:8) {
                        ForEach(Array(s.plan.enumerated()),id:\.offset) { i,step in
                            let finished = s.requestProgress?.pending.isEmpty == true && ["reviewed","steps_completed","verified","needs_review"].contains(s.requestProgress?.status ?? "")
                            HStack(alignment:.top,spacing:8) { Image(systemName:finished || i < s.stepIndex ? "checkmark.circle.fill" : i == s.stepIndex ? "circle.inset.filled" : "circle").foregroundStyle(i <= s.stepIndex ? green : .secondary)
                                Text(step.label).font(.caption) }
                        }
                        }
                    }
                    Divider()
                    if let count = model.snapshot?.experienceCount, count > 0 {
                        Text("\(count) task experiences retained").font(.caption2).foregroundStyle(.secondary)
                    }
                    Text("BACKPACK").font(.system(size:10,weight:.bold)).tracking(1.5).foregroundStyle(.secondary)
                    if let inventory = model.snapshot?.inventory, !inventory.isEmpty {
                        VStack(alignment:.leading,spacing:6) {
                        ForEach(inventory.keys.sorted(),id:\.self) { key in HStack { Text(key.replacingOccurrences(of:"_",with:" ")).font(.caption); Spacer(); Text("\(inventory[key]!)").font(.system(.caption,design:.monospaced).weight(.semibold)).foregroundStyle(green) }.padding(.vertical,3) }
                        }
                    } else { Text(model.snapshot == nil ? "Connect to view inventory" : "Nothing carried yet").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Text(modelStatus).font(.caption2).foregroundStyle(.secondary).lineSpacing(4)
                }.frame(width:216,alignment:.leading).padding(22)
                }.frame(width:260).background(Color(red:0.055,green:0.06,blue:0.105))
                Divider()
                VStack(spacing:0) {
                    SoulHero()
                    if model.snapshot?.dead == true {
                        HStack {
                            Text("Your teammate died. Respawning keeps the previous task paused.").font(.callout)
                            Spacer()
                            Button(model.snapshot?.respawning == true ? "Respawning…" : "Respawn agent") { model.respawn() }.buttonStyle(.borderedProminent).disabled(model.snapshot?.respawning == true)
                        }.padding(12).background(Color.orange.opacity(0.12))
                    }
                    if let session = model.snapshot?.survivalSession {
                        HStack {
                            Image(systemName:"sun.and.horizon.fill").foregroundStyle(.cyan)
                            VStack(alignment:.leading,spacing:3) {
                                Text("Survival session · \(session.completedCycles)/\(session.days) cycles · \(session.status)").font(.caption.bold())
                                Text(session.reason).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }.padding(12).background(Color.cyan.opacity(0.06))
                    }
                    if let issue = model.snapshot?.connectionIssue {
                        Text(issue).font(.caption).foregroundStyle(.orange).padding(12).frame(maxWidth:.infinity,alignment:.leading)
                    }
                    if model.snapshot?.modelReady == false {
                        HStack {
                            Text("Your thinking model isn’t ready. Check its login and settings.").font(.caption)
                            Spacer()
                            Button("Models") { showModels = true }
                        }.padding(12).background(Color.purple.opacity(0.1))
                    }
                    if let login = model.snapshot?.authentication {
                        HStack {
                            VStack(alignment:.leading) {
                                Text("Sign in to the bot’s Microsoft account").font(.headline)
                                Text("Code: \(login.code)").font(.system(.body,design:.monospaced)).textSelection(.enabled)
                            }
                            Spacer()
                            Link("Open Microsoft sign-in",destination:URL(string:"https://www.microsoft.com/link")!)
                        }.padding(16).background(Color.purple.opacity(0.18))
                    }
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment:.leading,spacing:18) {
                                if model.snapshot?.messages.isEmpty != false {
                                    VStack(alignment:.leading,spacing:14) {
                                        Text("Let’s make something worth exploring.").font(.title2.weight(.semibold))
                                        Text("Talk naturally. Ask me to gather, craft, build, bring you supplies, or follow you.").foregroundStyle(.secondary)
                                        Text("Try: “Make me a stone pickaxe and bring it to me.”").font(.callout).foregroundStyle(green)
                                    }.padding(.vertical,32)
                                }
                                ForEach(model.snapshot?.messages ?? []) { m in
                                    SoulMessage(message:m).id(m.id)
                                }
                                if model.snapshot?.phase == "thinking" { ProgressView("Thinking through your request…").controlSize(.small) }
                            }.padding(22)
                        }.onChange(of:model.snapshot?.messages.last?.id) { _, id in if let id { proxy.scrollTo(id,anchor:.bottom) } }
                    }
                    if !model.error.isEmpty { Text(model.error).font(.caption).foregroundStyle(.orange).frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,20).padding(.bottom,10) }
                    if model.listening { HStack { Image(systemName:"waveform").foregroundStyle(green); Text(model.voiceDraft.isEmpty ? "Listening… press the shortcut again to send" : model.voiceDraft).font(.callout); Spacer() }.padding(14).background(green.opacity(0.1)) }
                    Divider()
                    VStack(spacing:12) {
                        HStack(spacing:10) {
                            TextField("What are we doing next?",text:$model.draft).textFieldStyle(.plain).font(.system(size:14)).onSubmit { model.send() }.padding(12).background(.white.opacity(0.06),in:RoundedRectangle(cornerRadius:9))
                            Button { model.send() } label: { Image(systemName:"arrow.up").frame(width:26,height:28) }.buttonStyle(.borderedProminent).tint(Color(red:0.48,green:0.30,blue:0.88)).help("Send message").accessibilityLabel("Send message").disabled(model.linking || model.draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                        }
                        HStack {
                            Button { model.toggleTalk() } label: { Label(model.listening ? "Send voice" : "Talk",systemImage:model.listening ? "stop.circle.fill" : "mic.fill") }.buttonStyle(.bordered).tint(model.listening ? green : nil)
                            Text("⌃⌥ Space · works in Minecraft").font(.caption2).foregroundStyle(.secondary)
                            Spacer()
                            Button("Stop bot",role:.destructive) { model.stop() }.keyboardShortcut(.escape,modifiers:[])
                        }
                    }.padding(18).background(Color(red:0.07,green:0.075,blue:0.13))
                }
            }
        }.frame(width:geometry.size.width,height:geometry.size.height)
        }.sheet(isPresented:$model.needsSetup) { SetupView(companion:model) }.sheet(isPresented:$showModels) { ModelSettingsView(model:model) }.tint(Color(red:0.65,green:0.48,blue:1)).frame(minWidth:880,minHeight:650).background(Color(red:0.035,green:0.04,blue:0.075)).preferredColorScheme(.dark)
    }
}
final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: CompanionModel?
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Set the running Dock tile explicitly as development bundles are rebuilt in place.
        if let url = Bundle.main.url(forResource:"AppIcon", withExtension:"icns"),
           let icon = NSImage(contentsOf:url) {
            NSApplication.shared.applicationIconImage = icon
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { true }
    func applicationWillTerminate(_ notification:Notification) { MainActor.assumeIsolated { model?.shutdown() } }
}
@main struct SoulStoneApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = CompanionModel()
    var body: some Scene {
        WindowGroup("SoulStone") { CompanionView(model:model).onAppear { delegate.model = model } }.defaultSize(width:1000,height:780)
    }
}
