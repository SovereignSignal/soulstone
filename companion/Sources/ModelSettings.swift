import SwiftUI
import Security

struct ModelProfile: Codable, Identifiable {
    var id: String; var kind: String; var label: String; var model: String; var url: String; var maxTokens: Int; var hasKey: Bool?
    var subscription: Bool { ["codex","claude"].contains(kind) }
    var keyAccount: String { id + "|" + kind + "|" + url }
    var body: [String:String] { ["id":id,"kind":kind,"label":label,"model":model,"url":url,"maxTokens":String(maxTokens)] }
    static var fresh: ModelProfile { .init(id:UUID().uuidString,kind:"codex",label:"Codex subscription",model:"",url:"",maxTokens:4096) }
}
struct ModelCatalog: Codable { let active:String; let profiles:[ModelProfile] }
enum ModelKeychain {
    static let service = "com.sovereignsignal.minecraft-teammate.models"
    static func query(_ p:ModelProfile)->[String:Any] { [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:p.keyAccount] }
    static func read(_ p:ModelProfile) throws -> String {
        var q=query(p);q[kSecReturnData as String]=true;q[kSecMatchLimit as String]=kSecMatchLimitOne
        var result:CFTypeRef?;let status=SecItemCopyMatching(q as CFDictionary,&result)
        if status==errSecItemNotFound{return ""}
        guard status==errSecSuccess,let data=result as? Data else {throw NSError(domain:"Keychain access failed (\(status))",code:Int(status))}
        return String(data:data,encoding:.utf8) ?? ""
    }
    static func save(_ key:String,for p:ModelProfile) throws {
        let q=query(p), attrs=[kSecValueData as String:Data(key.utf8)]
        var status=SecItemUpdate(q as CFDictionary,attrs as CFDictionary)
        if status==errSecItemNotFound { var entry=q;entry.merge(attrs){_,new in new};status=SecItemAdd(entry as CFDictionary,nil) }
        guard status==errSecSuccess else {throw NSError(domain:"Could not save key in Keychain (\(status))",code:Int(status))}
    }
}
extension CompanionModel {
    func modelsRequest(_ path:String, body:[String:String]? = nil) async throws -> Data {
        let request=try makeRequest(path,method:body == nil ? "GET":"POST",body:body)
        let (data,response)=try await URLSession.shared.data(for:request)
        guard let status=(response as? HTTPURLResponse)?.statusCode,(200..<300).contains(status) else {
            let message=(try? JSONSerialization.jsonObject(with:data) as? [String:String])?["error"] ?? "Model settings request failed"
            throw NSError(domain:message,code:1)
        }
        return data
    }
    func restoreModelKey() async {
        do {
            let data=try await modelsRequest("/models")
            let catalog=try JSONDecoder().decode(ModelCatalog.self,from:data)
            if let p=catalog.profiles.first(where:{$0.id==catalog.active}),p.kind != "local",!p.subscription,p.hasKey != true {
                let key=try ModelKeychain.read(p)
                if !key.isEmpty { _ = try await modelsRequest("/credentials",body:["id":p.id,"apiKey":key,"url":p.url]) }
            }
        } catch { self.error=error.localizedDescription }
    }
}
struct ModelSettingsView:View {
    @ObservedObject var model:CompanionModel
    @Environment(\.dismiss) var dismiss
    @State private var profiles:[ModelProfile]=[]
    @State private var selected=""
    @State private var profile=ModelProfile.fresh
    @State private var key=""
    @State private var outputLimit="4096"
    @State private var message=""
    @State private var busy=false
    @State private var modelValid=false
    var body:some View {
        VStack(alignment:.leading,spacing:16) {
            Text("Teammate model").font(.title2.bold())
            HStack {
                Picker("Saved models",selection:$selected) {
                    Text("New profile").tag("")
                    ForEach(profiles){p in Text(p.label+" · "+p.model).tag(p.id)}
                }.onChange(of:selected){_,id in
                    if let p=profiles.first(where:{$0.id==id}){profile=p;outputLimit=String(p.maxTokens);key="";message=""}
                }
                Button("Add model"){selected="";profile = .fresh;key="";outputLimit="4096";message=""}
            }
            Form {
                TextField("Profile name",text:$profile.label)
                Picker("Provider",selection:Binding(get:{profile.kind},set:{ kind in
                    profile.kind=kind;key=""
                    if ["codex","claude"].contains(kind){profile.url="";return}
                    if kind=="openai"{profile.url="https://api.openai.com/v1/responses"}
                    else if kind=="local"{profile.url="http://127.0.0.1:1234/v1/chat/completions"}
                    else {profile.url=""}
                })) {
                    Text("Codex · ChatGPT subscription").tag("codex")
                    Text("Claude Code · Claude subscription").tag("claude")
                    Text("OpenAI · Responses API").tag("openai")
                    Text("OpenAI-compatible provider").tag("compatible")
                    Text("Local · LM Studio / compatible").tag("local")
                }
                if !profile.subscription {TextField("Full API endpoint",text:$profile.url).disabled(profile.kind=="openai")}
                if profile.kind != "local" && !profile.subscription {
                    SecureField("API key (blank keeps the saved key for this endpoint)",text:$key)
                }
                if !profile.subscription {TextField("Maximum output tokens",text:$outputLimit)}
            }.textFieldStyle(.roundedBorder)
            ProviderModelPicker(kind:profile.kind,endpoint:profile.url,selection:$profile.model,valid:$modelValid) {
                let credential = !profile.subscription && profile.kind != "local" && key.isEmpty ? try ModelKeychain.read(profile) : key
                return try await model.discoverModels(kind:profile.kind,url:profile.url,key:credential)
            }
            if profile.subscription {
                Text("Uses the installed official CLI and its saved subscription login. No API key or API fallback. Complex requests can use multiple planning calls from your subscription allowance; the CLI controls token usage. Conversation and observed game state are sent to the selected service. Tools are disabled; the Minecraft harness executes the plan. Saving makes no model call.").font(.caption).foregroundStyle(.secondary)
                Text(profile.kind == "codex" ? "Login: codex login. Use ChatGPT sign-in." : "Login: claude auth login. Use your Claude subscription.").font(.caption)
            } else if profile.kind == "local" {
                Text("Uses the model already loaded on this computer. Saving does not download or call a model.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("After activation, conversational requests send up to 12 recent messages and observed game state to this endpoint. Provider API charges apply. A complex request can use multiple planning calls, each capped at the output limit above. Clear wood commands and Stop execute locally. Saving makes no model call.").font(.caption).foregroundStyle(.secondary)
                Text("Choose a text model that supports JSON-schema structured output. After entering a key, click Refresh models. Keys are stored in macOS Keychain and bound to this profile and endpoint.").font(.caption).foregroundStyle(.secondary)
            }
            Text("Changing models cancels an active plan. Existing follow mode is preserved.").font(.caption).foregroundStyle(.secondary)
            if !message.isEmpty {Text(message).font(.callout).foregroundStyle(.orange)}
            HStack { Button("Close"){dismiss()};Spacer();if busy{ProgressView().controlSize(.small)}
                Button("Save & use model") {Task{await save()}}.buttonStyle(.borderedProminent).disabled(busy || !modelValid || (!profile.subscription && profile.url.isEmpty))
            }
        }.padding(24).frame(width:650).background(Color(red:0.055,green:0.06,blue:0.105)).tint(Color(red:0.65,green:0.48,blue:1)).task{await load()}
    }
    private func load() async {
        do {let data=try await model.modelsRequest("/models");let catalog=try JSONDecoder().decode(ModelCatalog.self,from:data);profiles=catalog.profiles;selected=catalog.active}
        catch {message=error.localizedDescription}
    }
    private func save() async {
        busy=true;defer{busy=false}
        do {
            guard let count=Int(outputLimit),(512...16384).contains(count) else {message="Use an output limit from 512 to 16384.";return}
            profile.maxTokens=count;profile.model=profile.model.trimmingCharacters(in:.whitespacesAndNewlines);profile.url=profile.url.trimmingCharacters(in:.whitespacesAndNewlines)
            var credential=""
            if profile.kind != "local" && !profile.subscription {
                credential=key.isEmpty ? try ModelKeychain.read(profile):key
                guard !credential.isEmpty else {message="Enter an API key for this provider.";return}
                if !key.isEmpty{try ModelKeychain.save(credential,for:profile)}
            }
            var body=profile.body;body["apiKey"]=credential
            let data=try await model.modelsRequest("/models",body:body)
            let catalog=try JSONDecoder().decode(ModelCatalog.self,from:data)
            if let saved=catalog.profiles.first(where:{$0.id==catalog.active}), !credential.isEmpty {try ModelKeychain.save(credential,for:saved)}
            profiles=catalog.profiles;selected=catalog.active;key="";message="Active: \(profile.label) / \(profile.model). No model call was made."
        } catch {message=error.localizedDescription}
    }
}
