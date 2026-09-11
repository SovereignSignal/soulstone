import SwiftUI

struct AgentConnectionView: View {
    @ObservedObject var companion: CompanionModel
    let close: () -> Void
    let manageWorlds: () -> Void
    @StateObject private var accounts = MinecraftAccountManager()
    @State private var profile: WorldSetup?
    @State private var loading = true
    @State private var busy = false
    @State private var problem = ""
    private var connected: Bool { companion.snapshot?.connected == true }
    private var changing: Bool { busy || companion.linking || accounts.signingOut }
    private var account: MinecraftAccount? { accounts.accounts.first { $0.id == profile?.minecraftAccountId } }
    private var issue: String { problem.isEmpty ? (companion.error.isEmpty ? companion.snapshot?.connectionIssue ?? "" : companion.error) : problem }
    private func readProfile() { profile = companion.usingLab ? nil : try? WorldSetup.read() }
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                Text("Agent connection").font(.title3.bold())
                Spacer()
                Button(action:close) { Image(systemName:"xmark") }.buttonStyle(.plain).accessibilityLabel("Close connection menu")
            }
            HStack(spacing:8) {
                Circle().fill(connected ? Color.cyan : .orange).frame(width:8,height:8)
                Text(companion.snapshot?.dead == true ? "Agent died · respawn needed" : connected ? "Connected to Minecraft" : companion.linking ? "Connecting…" : "Disconnected").font(.headline)
                if changing { ProgressView().controlSize(.small) }
            }
            VStack(alignment:.leading,spacing:6) {
                Label("World profile",systemImage:"globe").font(.caption).foregroundStyle(.secondary)
                Text(profile?.displayName ?? companion.worldName).font(.headline)
                if let profile {
                    Text("\(profile.host):\(String(profile.port))").font(.callout).textSelection(.enabled)
                    Text(companion.snapshot?.minecraftVersion.map { "Java " + $0 } ?? (profile.version == "auto" ? "Java version: automatic" : "Java " + profile.version)).font(.caption).foregroundStyle(.secondary)
                }
                if let translation = companion.snapshot?.translation { Text(translation).font(.caption).foregroundStyle(.secondary) }
            }
            Divider()
            VStack(alignment:.leading,spacing:8) {
                Label("Minecraft account",systemImage:"person.crop.circle").font(.caption).foregroundStyle(.secondary)
                if let account {
                    Text(account.name).font(.headline)
                    Text("Linked on this Mac").font(.caption).foregroundStyle(.secondary)
                    MinecraftAccountSignOutButton(companion:companion,accounts:accounts,account:account,onRemoved:readProfile)
                } else if loading {
                    Text("Loading account…").foregroundStyle(.secondary)
                } else if companion.usingLab || profile?.auth == "offline" {
                    Text(companion.snapshot?.botName ?? profile?.username ?? "Lab player").font(.headline)
                    Text("Lab connection · no linked Minecraft account selected").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(profile?.minecraftAccountId == nil ? "No account linked" : "Linked account unavailable").font(.headline)
                    Text("Choose or link a Minecraft Java account below.").font(.caption).foregroundStyle(.secondary)
                }
                if !accounts.message.isEmpty { Text(accounts.message).font(.caption).foregroundStyle(.secondary) }
            }
            Button("Change world or account…",action:manageWorlds).disabled(changing)
            Divider()
            if !issue.isEmpty { Text(issue).font(.callout).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true) }
            if companion.snapshot?.dead == true {
                Button(companion.snapshot?.respawning == true ? "Respawning…" : "Respawn agent") { companion.respawn() }.buttonStyle(.borderedProminent).disabled(companion.snapshot?.respawning == true || changing)
                Text("Return at the account's spawn point. The previous task stays paused; dropped inventory is not restored.").font(.caption).foregroundStyle(.secondary)
            } else if connected {
                Button("Disconnect agent") {
                    busy = true; problem = ""
                    Task {
                        do { try await companion.disconnectAgent() }
                        catch { problem = error.localizedDescription }
                        busy = false
                    }
                }.disabled(changing)
                Text("Pauses work and leaves Minecraft. Your account stays linked. Connect again when you’re ready.").font(.caption).foregroundStyle(.secondary)
            } else {
                Button("Connect agent") {
                    busy = true; problem = ""
                    Task { await companion.connect(); busy = false }
                }.buttonStyle(.borderedProminent).disabled(changing || loading || accounts.signingIn)
                Text(companion.manuallyDisconnected ? "You disconnected the agent. It will stay offline until you choose Connect agent." : "Connect using the world profile and account shown above.").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(20).frame(width:350).fixedSize(horizontal:false,vertical:true)
            .background(Color(red:0.055,green:0.06,blue:0.105)).preferredColorScheme(.dark)
            .task { readProfile(); await accounts.reload(using:companion); loading = false }
            .onChange(of:accounts.accounts) { _, _ in readProfile() }
    }
}
