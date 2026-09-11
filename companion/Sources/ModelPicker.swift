import SwiftUI

struct DiscoveredModel: Decodable, Identifiable {
    let id: String
    let label: String
    let description: String
    let isDefault: Bool
}
struct DiscoveredModels: Decodable { let models: [DiscoveredModel]; let source: String }

struct ProviderModelPicker: View {
    let kind: String
    let endpoint: String
    @Binding var selection: String
    @Binding var valid: Bool
    let load: () async throws -> DiscoveredModels
    @State private var choices: [DiscoveredModel] = []
    @State private var busy = false
    @State private var error = ""
    @State private var custom = false
    @State private var requestID = UUID()
    private var sourceID: String { kind + "|" + endpoint }
    private func validate() {
        valid = custom ? !selection.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty : !busy && choices.contains(where: { $0.id == selection })
    }
    @MainActor private func refresh() async {
        let id = UUID(); requestID = id; busy = true; valid = false; error = ""; choices = []
        do {
            let result = try await load()
            guard requestID == id, !Task.isCancelled else { return }
            choices = result.models
            if selection.isEmpty { selection = choices.first(where: { $0.isDefault })?.id ?? choices.first?.id ?? "" }
        } catch {
            guard requestID == id, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
        busy = false; validate()
    }
    var body: some View {
        VStack(alignment:.leading,spacing:8) {
            HStack {
                Picker("Model",selection:$selection) {
                    if !choices.contains(where: { $0.id == selection }) {
                        Text(selection.isEmpty ? "Choose a model" : "Select an available model").tag(selection)
                    }
                    ForEach(choices) { choice in Text(choice.label).tag(choice.id) }
                }.disabled(busy || custom || choices.isEmpty)
                Button("Refresh models") { Task { await refresh() } }.disabled(busy)
                if busy { ProgressView().controlSize(.small) }
            }
            if let choice = choices.first(where: { $0.id == selection }), !custom {
                Text(choice.description).font(.caption).foregroundStyle(.secondary)
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.orange) }
            DisclosureGroup("Advanced") {
                Toggle("Use a custom model ID",isOn:$custom).font(.caption)
                if custom { TextField("Custom model ID",text:$selection).textFieldStyle(.roundedBorder) }
            }.font(.caption).foregroundStyle(.secondary)
        }
        .task(id:sourceID) { custom = false; await refresh() }
        .onChange(of:selection) { _, _ in validate() }
        .onChange(of:custom) { _, _ in validate() }
        .onDisappear { requestID = UUID() }
    }
}
