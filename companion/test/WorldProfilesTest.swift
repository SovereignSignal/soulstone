import Foundation

@main struct WorldProfilesTest {
    static func main() throws {
        func expect(_ condition: @autoclosure () throws -> Bool) rethrows {
            let passed = try condition(); assert(passed)
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("soul-worlds-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let store = WorldProfileStore(directory:root)
        try expect(try store.list().isEmpty)
        var first = WorldSetup(); first.name = "First"; first.host = "localhost"; first.owner = "Tester"; first.username = "SoulTest"; first.auth = "offline"
        try store.save(first)
        var selected = try store.current()
        let key = selected.identity
        let state = root.appendingPathComponent("worlds/\(selected.id)/state/marker.txt")
        try FileManager.default.createDirectory(at:state.deletingLastPathComponent(),withIntermediateDirectories:true)
        try Data("world one".utf8).write(to:state)
        selected.port = 54321; selected.version = "26.1"; try store.save(selected)
        try expect(try store.current().identity == key)
        try expect(try String(contentsOf:state,encoding:.utf8) == "world one")
        let second = selected.freshWorld(); try store.save(second)
        try expect(try store.current().identity != key)
        try expect(try store.list().count == 2)
        try store.save(selected)
        try expect(try store.current().id == first.id)
        let permissions = try FileManager.default.attributesOfItem(atPath:root.appendingPathComponent("setup.json").path)[.posixPermissions] as! NSNumber
        assert(permissions.intValue == 0o600)
        var invalid = selected; invalid.identity = "wrong"
        do { try store.save(invalid); fatalError("Identity replacement accepted") } catch {}
        invalid = selected; invalid.id = "../outside"
        do { try store.save(invalid); fatalError("Path traversal accepted") } catch {}
        try expect(try store.current().id == first.id)

        let legacyRoot = root.appendingPathComponent("legacy")
        try FileManager.default.createDirectory(at:legacyRoot,withIntermediateDirectories:true)
        var legacy = first; legacy.identity = nil; legacy.name = nil
        try JSONEncoder().encode(legacy).write(to:legacyRoot.appendingPathComponent("setup.json"))
        let oldStore = WorldProfileStore(directory:legacyRoot)
        var migrated = try oldStore.current()
        let legacyKey = String(decoding:try JSONSerialization.data(withJSONObject:["localhost",25565,"SoulTest","auto"]),as:UTF8.self)
        assert(migrated.identity == legacyKey)
        migrated.port = 55555; try oldStore.save(migrated)
        try expect(try oldStore.current().identity == legacyKey)
        try expect(try oldStore.list().count == 1)
        var linked = selected
        linked.auth = "microsoft"; linked.minecraftAccountId = UUID().uuidString
        try store.save(linked)
        try expect(try store.current().minecraftAccountId == linked.minecraftAccountId)
        expect(linked.freshWorld().minecraftAccountId == linked.minecraftAccountId)
        try expect(try oldStore.current().minecraftAccountId == nil)
        var sibling = linked.freshWorld(); sibling.name = "Same account in another world"
        try store.save(sibling)
        var otherAccount = linked.freshWorld(); otherAccount.minecraftAccountId = UUID().uuidString
        try store.save(otherAccount); try store.save(linked)
        try store.unlinkAccount(linked.minecraftAccountId!)
        try expect(try store.current().id == linked.id)
        try expect(try store.current().minecraftAccountId == nil)
        try expect(try store.current().username == "")
        try expect(try store.current().identity == key)
        try expect(try store.list().first(where:{$0.id == sibling.id})?.minecraftAccountId == nil)
        try expect(try store.list().first(where:{$0.id == otherAccount.id})?.minecraftAccountId == otherAccount.minecraftAccountId)
        try expect(try String(contentsOf:state,encoding:.utf8) == "world one")
        try store.unlinkAccount(linked.minecraftAccountId!)
        let draftRoot = root.appendingPathComponent("drafts"), draftStore = WorldProfileStore(directory:draftRoot)
        var draft = WorldSetup(); draft.name = "New LAN"; draft.host = "127.0.0.1"; draft.port = 58838
        draft = try draftStore.save(draft,activate:false)
        try expect(try draftStore.list().count == 1)
        expect(!FileManager.default.fileExists(atPath:draftRoot.appendingPathComponent("setup.json").path))
        expect(draft.identity != nil && draft.minecraftAccountId == nil)
        try store.save(otherAccount,activate:false)
        try expect(try store.current().id == linked.id)

        let accountsMarker = root.appendingPathComponent("accounts/keep.txt")
        try FileManager.default.createDirectory(at:accountsMarker.deletingLastPathComponent(),withIntermediateDirectories:true)
        try Data("account fixture retained".utf8).write(to:accountsMarker)
        try store.remove(sibling.id)
        try expect(try !store.list().contains(where:{$0.id == sibling.id}))
        try expect(try store.current().id == linked.id)
        try store.remove(linked.id)
        expect(!FileManager.default.fileExists(atPath:root.appendingPathComponent("setup.json").path))
        try expect(try String(contentsOf:state,encoding:.utf8) == "world one")
        try expect(try String(contentsOf:accountsMarker,encoding:.utf8) == "account fixture retained")
        expect(FileManager.default.fileExists(atPath:root.appendingPathComponent("worlds/\(linked.id)/removed-setup.json").path))
        do { try store.save(linked); fatalError("Removed entry resurrected by save") } catch {}
        try JSONEncoder().encode(linked).write(to:root.appendingPathComponent("setup.json"))
        try expect(try !store.list().contains(where:{$0.id == linked.id}))
        do { _ = try store.current(); fatalError("Removed entry resurrected by legacy pointer") } catch {}
        do { try store.remove("../outside"); fatalError("Removal path traversal accepted") } catch {}
        let symbolic = UUID().uuidString
        try FileManager.default.createSymbolicLink(at:root.appendingPathComponent("worlds/\(symbolic)"),withDestinationURL:draftRoot.appendingPathComponent("worlds/\(draft.id)"))
        do { try store.remove(symbolic); fatalError("Removal through symlink accepted") } catch {}
        try expect(try draftStore.list().contains(where:{$0.id == draft.id}))
        print("PASS: offline draft saving without account/activation; removal clears active selection, hides entries, retains history/accounts and prevents resurrection; account unlink, world identity, migration and path guards")
    }
}
