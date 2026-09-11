import Foundation

struct WorldSetup: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var name: String? = nil
    var identity: String? = nil
    var host = ""
    var port = 25565
    var owner = ""
    var username = ""
    var auth = "microsoft"
    var minecraftAccountId: String? = nil
    var version = "auto"
    var provider = "codex"
    var model = "gpt-6-astra"
    var displayName: String { name?.isEmpty == false ? name! : host }
    static var directory: URL {
        // Development UI tests can use an isolated store; portable builds
        // have no development.json and always use private app storage.
        if let config = Bundle.main.url(forResource:"development",withExtension:"json"),
           let data = try? Data(contentsOf:config),
           let object = try? JSONSerialization.jsonObject(with:data) as? [String:Any],
           let path = object["profileDirectory"] as? String {
            return URL(fileURLWithPath:path,isDirectory:true)
        }
        return FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("Vibrant Soul",isDirectory:true)
    }
    static var store: WorldProfileStore { WorldProfileStore(directory:directory) }
    static var file: URL { directory.appendingPathComponent("setup.json") }
    static func read() throws -> WorldSetup { try store.current() }
    var worldDirectory: URL { Self.directory.appendingPathComponent("worlds/\(id)",isDirectory:true) }
    var profileFile: URL { worldDirectory.appendingPathComponent("setup.json") }
    func freshWorld() -> WorldSetup {
        var copy = self; copy.id = UUID().uuidString; copy.identity = nil
        copy.name = displayName + " (new world)"
        return copy
    }
}

struct WorldProfileStore {
    let directory: URL
    private var manager: FileManager { .default }
    private var activeFile: URL { directory.appendingPathComponent("setup.json") }
    private func folder(_ id: String) throws -> URL {
        guard UUID(uuidString:id) != nil else { throw failure("Invalid saved world ID.") }
        return directory.appendingPathComponent("worlds/\(id)",isDirectory:true)
    }
    private func failure(_ message: String) -> NSError {
        NSError(domain:"SoulStone.Worlds",code:1,userInfo:[NSLocalizedDescriptionKey:message])
    }
    private func identity(_ values: [Any]) throws -> String {
        String(decoding:try JSONSerialization.data(withJSONObject:values,options:[.fragmentsAllowed,.withoutEscapingSlashes]),as:UTF8.self)
    }
    private func decode(_ url: URL) throws -> WorldSetup {
        var value = try JSONDecoder().decode(WorldSetup.self,from:Data(contentsOf:url))
        _ = try folder(value.id)
        if value.identity == nil {
            // Preserve a V1 connection key before editing its address or port.
            var values: [Any] = [value.host,value.port,value.username,value.version]
            if value.auth == "microsoft" { values.append(value.auth) }
            value.identity = try identity(values)
        }
        return value
    }
    private func write(_ value: WorldSetup, to url: URL) throws {
        try manager.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try JSONEncoder().encode(value).write(to:url,options:.atomic)
        try manager.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
    }
    func current() throws -> WorldSetup {
        let selected = try decode(activeFile)
        guard !manager.fileExists(atPath:try folder(selected.id).appendingPathComponent("removed-setup.json").path) else { throw failure("This connection was removed. Choose another saved connection.") }
        let file = try folder(selected.id).appendingPathComponent("setup.json")
        if manager.fileExists(atPath:file.path) {
            let saved = try decode(file)
            guard saved.id == selected.id else { throw failure("Saved world does not match its folder.") }
            return saved
        }
        try write(selected,to:file)
        return selected
    }
    func list() throws -> [WorldSetup] {
        if manager.fileExists(atPath:activeFile.path) {
            let selected = try decode(activeFile)
            if !manager.fileExists(atPath:try folder(selected.id).appendingPathComponent("removed-setup.json").path) { _ = try current() }
        }
        let worlds = directory.appendingPathComponent("worlds",isDirectory:true)
        guard manager.fileExists(atPath:worlds.path) else { return [] }
        var values: [WorldSetup] = []
        for folder in try manager.contentsOfDirectory(at:worlds,includingPropertiesForKeys:nil) {
            guard UUID(uuidString:folder.lastPathComponent) != nil else { continue }
            let file = folder.appendingPathComponent("setup.json")
            if manager.fileExists(atPath:folder.appendingPathComponent("removed-setup.json").path) { continue }
            guard manager.fileExists(atPath:file.path) else { continue }
            let value = try decode(file)
            guard value.id == folder.lastPathComponent else { throw failure("Saved world does not match its folder.") }
            values.append(value)
        }
        return values.sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }
    func unlinkAccount(_ id: String) throws {
        let activeID = manager.fileExists(atPath:activeFile.path) ? try current().id : nil
        for var world in try list() where world.minecraftAccountId == id {
            world.minecraftAccountId = nil
            if world.auth == "microsoft" { world.username = "" }
            try write(world,to:try folder(world.id).appendingPathComponent("setup.json"))
            if world.id == activeID { try write(world,to:activeFile) }
        }
    }
    func remove(_ id: String) throws {
        let location = try folder(id)
        for url in [directory,directory.appendingPathComponent("worlds"),location,location.appendingPathComponent("setup.json")] where manager.fileExists(atPath:url.path) {
            guard try url.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink != true else { throw failure("Cannot remove a connection through a symbolic link.") }
        }
        let file = location.appendingPathComponent("setup.json"), removed = location.appendingPathComponent("removed-setup.json")
        guard manager.fileExists(atPath:file.path) else { throw failure("This saved connection no longer exists.") }
        let value = try decode(file)
        guard value.id == id else { throw failure("Saved connection does not match its folder.") }
        // Keep history and a recoverable local copy. The tombstone prevents
        // legacy-pointer migration from resurrecting a removed connection.
        try manager.moveItem(at:file,to:removed)
        if manager.fileExists(atPath:activeFile.path), try decode(activeFile).id == id { try manager.removeItem(at:activeFile) }
    }
    @discardableResult func save(_ setup: WorldSetup, activate: Bool = true) throws -> WorldSetup {
        var value = setup
        let file = try folder(value.id).appendingPathComponent("setup.json")
        guard !manager.fileExists(atPath:try folder(value.id).appendingPathComponent("removed-setup.json").path) else { throw failure("This connection was removed. Add a new connection instead.") }
        value.name = value.name?.trimmingCharacters(in:.whitespacesAndNewlines)
        guard (value.name?.count ?? 0) <= 80, !(value.name?.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) ?? false) else { throw failure("Use a world name of up to 80 characters.") }
        if value.identity == nil { value.identity = try identity(["world",value.id]) }
        if manager.fileExists(atPath:file.path) {
            let previous = try decode(file)
            guard previous.identity == value.identity else { throw failure("This edit would replace the world's identity. Create a new world profile instead.") }
        }
        try write(value,to:file)
        // Change the active pointer last; a failed save retains the old choice.
        if activate { try write(value,to:activeFile) }
        return value
    }
}
