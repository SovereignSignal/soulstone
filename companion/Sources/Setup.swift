import SwiftUI

struct ConnectionCheck: Decodable { let status: String; let message: String }

struct SetupView: View {
    @ObservedObject var companion: CompanionModel
    @AppStorage("connectionEditorSelection") private var selectedID = ""
    @State private var worlds: [WorldSetup] = []
    @State private var setup = WorldSetup()
    @State private var port = "25565"
    @State private var busy = false
    @State private var problem = ""
    @State private var notice = ""
    @State private var noticeProfile: WorldSetup?
    @State private var confirmRemoval = false
    @State private var check: ConnectionCheck?
    @State private var editing = false
    @State private var modelValid = false
    @StateObject private var accounts = MinecraftAccountManager()
    private var accountReady: Bool {
        setup.auth == "offline" || accounts.accounts.contains { $0.id == setup.minecraftAccountId }
    }
    private var working: Bool { busy || accounts.signingIn || accounts.signingOut }
    private var savedSelection: WorldSetup? { worlds.first { $0.id == setup.id } }

    private func select(_ world: WorldSetup) {
        setup = world; selectedID = world.id; port = String(world.port); editing = true; problem = ""; notice = ""; check = nil
    }
    private func profile() throws -> WorldSetup {
        guard let number = Int(port) else { throw NSError(domain:"SoulStone.Worlds",code:1,userInfo:[NSLocalizedDescriptionKey:"Enter a numeric server port."]) }
        var value = setup; value.port = number
        return value
    }
    private func save(connect: Bool) {
        busy = true; problem = ""; notice = ""
        Task {
            var saved = false
            do {
                let value = try await companion.saveConnection(profile())
                saved = true; worlds = try WorldSetup.store.list(); select(value)
                noticeProfile = setup; notice = "Connection saved."
                if connect { try await companion.configure(value) }
            } catch { problem = (saved && connect ? "Connection saved, but could not connect: " : "") + error.localizedDescription }
            busy = false
        }
    }
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack(spacing:14) {
                BrandArtwork(name:"SoulLantern").frame(width:48,height:48)
                VStack(alignment:.leading,spacing:4) {
                    Text("World connections").font(.title.bold())
                    Text("Choose where the agent plays, then the Minecraft account it plays as.").foregroundStyle(.secondary)
                }
            }
            HStack(alignment:.top,spacing:22) {
                VStack(alignment:.leading,spacing:12) {
                    Text("SAVED CONNECTIONS").font(.caption.bold()).foregroundStyle(.secondary)
                    if companion.hasLabConfiguration {
                        Button("Return to Minecraft lab") {
                            busy = true
                            Task { do { try await companion.connectToLab() } catch { problem = error.localizedDescription }; busy = false }
                        }.disabled(busy)
                    }
                    ScrollView {
                        VStack(alignment:.leading,spacing:8) {
                            ForEach(worlds) { world in
                                Button { select(world) } label: {
                                    VStack(alignment:.leading,spacing:4) {
                                        Text(world.displayName).font(.headline)
                                        Text("\(world.host):\(String(world.port))").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }.frame(maxWidth:.infinity,alignment:.leading).padding(10)
                                        .background(setup.id == world.id ? Color.purple.opacity(0.2) : Color.white.opacity(0.04))
                                        .clipShape(RoundedRectangle(cornerRadius:8))
                                }.buttonStyle(.plain).disabled(busy)
                            }
                        }
                    }
                    Button("Add connection") { select(WorldSetup()); editing = false }.disabled(working)
                    if savedSelection != nil {
                        Button("Remove saved connection…",role:.destructive) { confirmRemoval = true }.disabled(working)
                    }
                    if worlds.isEmpty { Text("Each world keeps its own locations, buildings and conversation history.").font(.caption).foregroundStyle(.secondary) }
                }.frame(width:210)
                Divider()
                ScrollView {
                    VStack(alignment:.leading,spacing:14) {
                        if setup.auth == "microsoft" {
                            MinecraftAccountPicker(companion:companion,accounts:accounts,selection:$setup.minecraftAccountId,owner:setup.owner)
                        }
                        Form {
                            TextField("Connection name",text:Binding(get:{setup.name ?? ""},set:{setup.name=$0}),prompt:Text("Our survival world"))
                            TextField("Server address",text:$setup.host,prompt:Text("play.example.com"))
                            TextField("Port",text:$port)
                            TextField("Java version",text:$setup.version,prompt:Text("auto"))
                        }.textFieldStyle(.roundedBorder)
                        HStack {
                            Button("LAN on this Mac") { setup.host = "127.0.0.1"; setup.version = "auto"; check = nil }
                            Button("Check connection") {
                                busy = true; problem = ""; check = nil
                                Task {
                                    do { check = try await companion.checkConnection(profile()) }
                                    catch { problem = error.localizedDescription }
                                    busy = false
                                }
                            }
                        }
                        Text("Open the world to LAN in Minecraft, then enter its displayed port. For another server, use an address this Mac can reach. Leave version on auto for supported releases.").font(.caption).foregroundStyle(.secondary)
                        if let check { Text(check.message).font(.callout).foregroundStyle(check.status == "reachable" ? Color.cyan : Color.orange).accessibilityIdentifier("connection-check-result") }
                        Divider()
                        Form {
                            TextField("Your Java player name",text:$setup.owner)
                            Picker("Bot login",selection:$setup.auth) {
                                Text("Linked Minecraft account").tag("microsoft")
                                Text("Offline lab server").tag("offline")
                            }
                            if setup.auth == "offline" { TextField("Bot player name",text:$setup.username) }
                        }.textFieldStyle(.roundedBorder)
                        if setup.auth == "offline" { Text("Offline login works only on servers configured to allow it. The bot needs a different name from your player.").font(.caption).foregroundStyle(.secondary) }
                        if !editing || setup.model.isEmpty {
                            Form {
                                Picker("Thinking provider",selection:$setup.provider) {
                                    Text("Codex subscription").tag("codex")
                                    Text("Claude subscription").tag("claude")
                                    Text("Muse subscription").tag("muse")
                                }.onChange(of:setup.provider) { _, _ in setup.model = "" }
                            }.textFieldStyle(.roundedBorder)
                            ProviderModelPicker(kind:setup.provider,endpoint:"",selection:$setup.model,valid:$modelValid) {
                                try await companion.discoverModels(kind:setup.provider)
                            }
                            Text("Install and sign in to the provider's official CLI on this Mac. Manage models after connecting. No API fallback.").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("Changing this world's LAN port keeps its history. For a different Minecraft world or a server reset, add a new connection. Accounts can be reused across connections.").font(.caption).foregroundStyle(.secondary)
                            Button("Duplicate for another world") { select(setup.freshWorld()); editing = false }
                        }
                        Text("Java only. Bedrock and invite-based connections are not available in this build.").font(.caption).foregroundStyle(.secondary)
                    }.disabled(busy)
                }.frame(maxWidth:.infinity)
            }
            if !problem.isEmpty { Text(problem).foregroundStyle(.orange).font(.callout) }
            if !notice.isEmpty { Text(notice).foregroundStyle(.cyan).font(.callout) }
            Text(!accountReady ? "Connection details are separate from sign-in. Link or choose a verified Minecraft account to continue." : "Save keeps connection details without joining. Editing the active connection pauses its agent.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Close") { companion.needsSetup = false }.disabled(working)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Save connection") { save(connect:false) }.disabled(working)
                Button(accountReady ? "Connect agent" : "Link account to connect") {
                    if !accountReady { accounts.link(using:companion) }
                    else if setup.owner.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty { problem = "Enter your Java player name so the agent knows who to follow and take commands from." }
                    else if setup.model.isEmpty || (!editing && !modelValid) { problem = "Choose an available thinking model before connecting." }
                    else { save(connect:true) }
                }.buttonStyle(.borderedProminent).disabled(working)
            }
        }.padding(24).frame(width:820,height:650)
            .background(Color(red:0.055,green:0.06,blue:0.105)).tint(.purple).preferredColorScheme(.dark)
            .interactiveDismissDisabled(busy || accounts.signingIn || accounts.signingOut)
            .onChange(of:setup) { _, value in check = nil; if value != noticeProfile { notice = "" } }
            .onChange(of:port) { _, value in check = nil; if value != noticeProfile.map({String($0.port)}) { notice = "" } }
            .onAppear {
                do {
                    worlds = try WorldSetup.store.list()
                    if let selected = worlds.first(where:{$0.id == selectedID}) { select(selected) }
                    else if let current = try? WorldSetup.read() { select(current) }
                    else if let first = worlds.first { select(first) }
                } catch { problem = "Saved worlds could not be read: " + error.localizedDescription }
            }
            .task { await accounts.reload(using:companion) }
            .onChange(of:accounts.accounts) { _, values in
                if let id = setup.minecraftAccountId, !values.contains(where:{$0.id == id}) { setup.minecraftAccountId = nil }
                do { worlds = try WorldSetup.store.list() } catch { problem = error.localizedDescription }
            }
            .onDisappear { if accounts.signingIn { accounts.cancel() } }
            .confirmationDialog("Remove \(savedSelection?.displayName ?? "this connection")?",isPresented:$confirmRemoval,titleVisibility:.visible) {
                Button("Remove saved connection",role:.destructive) {
                    guard let target = savedSelection else { return }
                    busy = true; problem = ""
                    Task {
                        do {
                            try await companion.removeConnection(target)
                            worlds = try WorldSetup.store.list()
                            if let first = worlds.first { select(first) } else { select(WorldSetup()); editing = false }
                            noticeProfile = setup; notice = "Connection removed. Minecraft worlds and linked accounts are unchanged."
                        } catch { problem = error.localizedDescription }
                        busy = false
                    }
                }
                Button("Cancel",role:.cancel) {}
            } message: {
                Text("This removes the entry from SoulStone's saved connections and disconnects its agent. Your Minecraft world and linked accounts are kept. SoulStone history remains stored locally for recovery.")
            }
    }
}
