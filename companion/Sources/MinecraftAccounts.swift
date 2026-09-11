import SwiftUI
import AppKit

struct MinecraftAccount: Codable, Identifiable, Equatable {
    let id: String
    let uuid: String
    let name: String
    let verifiedAt: Double
}
struct AccountEvent: Decodable {
    let type: String
    let accounts: [MinecraftAccount]?
    let account: MinecraftAccount?
    let code: String?
    let expiresAt: Double?
    let message: String?
}

@MainActor final class MinecraftAccountManager: ObservableObject {
    @Published var accounts: [MinecraftAccount] = []
    @Published var signingIn = false
    @Published var signingOut = false
    @Published var code = ""
    @Published var expiresAt: Double?
    @Published var message = ""
    @Published var linkedID = ""
    @Published var needsJavaProfile = false
    private var process: Process?
    private var generation = UUID()

    func reload(using companion: CompanionModel) async {
        do { accounts = try await companion.accountRequest(action:"list").accounts ?? [] }
        catch { message = error.localizedDescription }
    }
    func link(using companion: CompanionModel) {
        guard !signingIn && !signingOut else { return }
        generation = UUID(); let current = generation
        signingIn = true; code = ""; expiresAt = nil; message = "Requesting a Microsoft sign-in code…"; linkedID = ""
        needsJavaProfile = false
        do {
            let p = try companion.accountProcess(), output = Pipe(), input = Pipe()
            p.standardOutput = output; p.standardError = FileHandle.nullDevice; p.standardInput = input
            try p.run(); process = p
            try input.fileHandleForWriting.write(contentsOf:companion.accountInput(action:"link"))
            try input.fileHandleForWriting.close()
            Task.detached { [weak self] in
                var buffer = Data(), total = 0
                do {
                    while true {
                        let data = output.fileHandleForReading.availableData
                        if data.isEmpty { break }
                        total += data.count
                        guard total < 65536 else { throw CocoaError(.fileReadTooLarge) }
                        buffer.append(data)
                        while let end = buffer.firstIndex(of:10) {
                            let line = Data(buffer[..<end]); buffer.removeSubrange(...end)
                            let event = try JSONDecoder().decode(AccountEvent.self,from:line)
                            await self?.receive(event,generation:current)
                        }
                    }
                    p.waitUntilExit()
                    await self?.ended(generation:current)
                } catch {
                    if p.isRunning { p.terminate() }
                    await self?.ended(generation:current)
                }
            }
        } catch {
            if let process, process.isRunning { process.terminate() }
            process = nil; signingIn = false; message = "Could not start Microsoft sign-in. Try again."
        }
    }
    private func receive(_ event: AccountEvent, generation current: UUID) {
        guard generation == current else { return }
        if event.type == "code", let code = event.code, let expires = event.expiresAt {
            self.code = code; expiresAt = expires
            message = "Sign in with the Microsoft account that owns the bot’s Minecraft Java Edition."
        } else if event.type == "linked", let account = event.account {
            accounts.removeAll { $0.id == account.id }; accounts.append(account)
            linkedID = account.id; signingIn = false; code = ""; expiresAt = nil
            needsJavaProfile = false
            message = "Linked \(account.name). Java profile verified. Click Connect agent to join."
        } else if event.type == "error" || event.type == "cancelled" {
            signingIn = false; code = ""; expiresAt = nil
            needsJavaProfile = event.type == "error" && event.code == "java_profile"
            message = event.message ?? "Sign-in cancelled. No account was linked."
        }
    }
    private func ended(generation current: UUID) {
        guard generation == current else { return }
        process = nil
        if signingIn { signingIn = false; code = ""; expiresAt = nil; message = "Sign-in ended before verification. Click Link Minecraft account to try again." }
    }
    func cancel() {
        generation = UUID()
        if let process, process.isRunning {
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline:.now()+3) { if process.isRunning { kill(process.processIdentifier,SIGKILL) } }
        }
        process = nil; signingIn = false; code = ""; expiresAt = nil
        message = "Sign-in cancelled. No account was linked."
    }
    func remove(_ id: String, using companion: CompanionModel) async {
        guard !signingIn && !signingOut else { return }
        signingOut = true
        defer { signingOut = false }
        do {
            try await companion.disconnectAccount(id)
            try WorldSetup.store.unlinkAccount(id)
            accounts = try await companion.accountRequest(action:"remove",id:id).accounts ?? []
            linkedID = ""
            message = "Signed out and unlinked from all SoulStone worlds on this Mac. You can link the account again."
        } catch { message = error.localizedDescription }
    }
}

struct MinecraftAccountPicker: View {
    @ObservedObject var companion: CompanionModel
    @ObservedObject var accounts: MinecraftAccountManager
    @Binding var selection: String?
    let owner: String
    private var selected: MinecraftAccount? { accounts.accounts.first { $0.id == selection } }
    var body: some View {
        VStack(alignment:.leading,spacing:10) {
            Label("Minecraft account",systemImage:"person.crop.circle.badge.checkmark").font(.headline)
            Text("Link any account with Minecraft Java access, including one you normally play with.").font(.caption).foregroundStyle(.secondary)
            if !accounts.accounts.isEmpty {
                Picker("Bot account",selection:Binding(get:{selection ?? ""},set:{selection=$0.isEmpty ? nil : $0})) {
                    Text("Choose a linked account").tag("")
                    ForEach(accounts.accounts) { Text($0.name).tag($0.id) }
                }.disabled(accounts.signingIn)
            }
            if let selected {
                Text("\(selected.name) · Java profile verified").foregroundStyle(.cyan)
                if selected.name.lowercased() == owner.trimmingCharacters(in:.whitespacesAndNewlines).lowercased() {
                    Text("SoulStone will play as this account. Leave the target server in Minecraft before connecting the bot. To play together in the same world, use two accounts.").font(.caption).foregroundStyle(.orange)
                }
            }
            if accounts.signingIn {
                if !accounts.code.isEmpty {
                    Text(accounts.code).font(.system(.title2,design:.monospaced).bold()).textSelection(.enabled)
                    HStack {
                        Link("Open Microsoft sign-in",destination:URL(string:"https://www.microsoft.com/link")!)
                        Button("Copy code") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(accounts.code,forType:.string) }
                    }
                    Text("Microsoft may label this request Minecraft for Nintendo Switch, the Minecraft sign-in client used by this alpha.").font(.caption).foregroundStyle(.secondary)
                    if let expiry = accounts.expiresAt {
                        TimelineView(.periodic(from:.now,by:1)) { context in
                            let remaining = max(0,Int((expiry/1000)-context.date.timeIntervalSince1970))
                            Text(remaining > 0 ? "Code expires in \(remaining / 60)m \(remaining % 60)s" : "Code expired. Cancel and link again.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else { ProgressView().controlSize(.small) }
                Button("Cancel sign-in") { accounts.cancel() }
            } else {
                HStack {
                    Button("Link Minecraft account") { accounts.link(using:companion) }
                    if let selected {
                        MinecraftAccountSignOutButton(companion:companion,accounts:accounts,account:selected) {
                            if selection == selected.id { selection = nil }
                        }
                    }
                }
                Link("Need Minecraft Java?",destination:URL(string:"https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc")!).font(.caption)
            }
            if !accounts.message.isEmpty { Text(accounts.message).font(.caption).foregroundStyle(.secondary) }
            if accounts.needsJavaProfile {
                Link("Open Minecraft account profile",destination:URL(string:"https://www.minecraft.net/en-us/msaprofile")!)
                Text("Check the Microsoft account used for your purchase and finish its Java player profile if prompted, then link it again here.").font(.caption).foregroundStyle(.secondary)
            }
            Text("Your password stays on Microsoft’s website. Sign-in is saved on this Mac and can be used with your other worlds. Signing out here does not sign out the Minecraft Launcher or your browser.").font(.caption).foregroundStyle(.secondary)
        }.disabled(accounts.signingOut).padding(14).background(Color.purple.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius:10))
            .onChange(of:accounts.linkedID) { _, id in if !id.isEmpty { selection = id } }
    }
}

struct MinecraftAccountSignOutButton: View {
    @ObservedObject var companion: CompanionModel
    @ObservedObject var accounts: MinecraftAccountManager
    let account: MinecraftAccount
    var onRemoved: () -> Void = {}
    @State private var confirmRemoval = false
    var body: some View {
        Button("Sign out & unlink…") { confirmRemoval = true }
            .disabled(companion.linking || accounts.signingIn || accounts.signingOut)
            .confirmationDialog("Sign out \(account.name)?",isPresented:$confirmRemoval,titleVisibility:.visible) {
                Button("Sign out & unlink",role:.destructive) {
                    Task {
                        await accounts.remove(account.id,using:companion)
                        if !accounts.accounts.contains(where:{$0.id == account.id}) { onRemoved() }
                    }
                }
                Button("Cancel",role:.cancel) {}
            } message: {
                Text("The agent will disconnect if it uses this account. Its saved login and account associations will be removed from all SoulStone worlds on this Mac. Your world history and Minecraft purchase are kept. Minecraft Launcher and browser sign-ins are unchanged.")
            }
    }
}
