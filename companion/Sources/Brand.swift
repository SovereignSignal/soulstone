import SwiftUI

/// Bundle images remain decorative; all status and controls are native views.
struct BrandArtwork: View {
    let name: String
    var body: some View {
        if let url = Bundle.main.url(forResource:name, withExtension:"png"), let image = NSImage(contentsOf:url) {
            // Clipping an aspect-fill image does not clip its mouse hit area.
            // Decorative artwork must never intercept nearby controls.
            Image(nsImage:image).resizable().aspectRatio(contentMode:.fill).accessibilityHidden(true).allowsHitTesting(false)
        } else { Color.indigo.accessibilityHidden(true).allowsHitTesting(false) }
    }
}

struct SoulHero: View {
    var body: some View {
        ZStack(alignment:.leading) {
            GeometryReader { geometry in
                BrandArtwork(name:"World").frame(width:geometry.size.width,height:148).clipped()
            }
            LinearGradient(colors:[Color.black.opacity(0.3),.clear], startPoint:.leading,endPoint:.trailing)
            VStack(alignment:.leading,spacing:8) {
                Text("BUILD • EXPLORE • SURVIVE").font(.system(size:9,weight:.bold)).tracking(2.5).foregroundStyle(Color(red:0.65,green:0.72,blue:1))
                Text("Your world.\nYour teammate.").font(.system(size:26,weight:.bold,design:.rounded)).foregroundStyle(.white)
                Text("A little soul. Infinite possibilities.").font(.caption).foregroundStyle(.white.opacity(0.75))
            }.padding(.horizontal,24)
        }.frame(height:148).clipped().accessibilityElement(children:.combine)
    }
}

struct VitalsView: View {
    let health: Double?
    let food: Int?
    var body: some View {
        HStack(spacing:10) {
            vital("Health",icon:"heart.fill",value:health,color:Color(red:1,green:0.4,blue:0.55))
            vital("Food",icon:"carrot.fill",value:food.map(Double.init),color:Color(red:1,green:0.72,blue:0.4))
        }
    }
    private func vital(_ label:String, icon:String, value:Double?, color:Color) -> some View {
        VStack(alignment:.leading,spacing:8) {
            Label(label,systemImage:icon).font(.caption2).foregroundStyle(color)
            Text(value.map { String(format:"%.0f / 20",$0) } ?? "Unknown").font(.system(size:14,weight:.semibold,design:.rounded))
            ProgressView(value:min(20,max(0,value ?? 0)),total:20).tint(color)
        }.padding(10).frame(maxWidth:.infinity).background(.white.opacity(0.035),in:RoundedRectangle(cornerRadius:10))
    }
}

struct SoulMessage: View {
    let message: Message
    private var isPlayer: Bool { message.role == "user" }
    var body: some View {
        HStack(alignment:.top,spacing:12) {
            if !isPlayer {
                BrandArtwork(name:"SoulLantern").frame(width:32,height:32).clipShape(RoundedRectangle(cornerRadius:8))
            }
            VStack(alignment:.leading,spacing:7) {
                Text(isPlayer ? "YOU" : "SOULSTONE · TEAMMATE")
                    .font(.system(size:9,weight:.bold)).tracking(1.3)
                    .foregroundStyle(isPlayer ? Color.gray : Color(red:0.47,green:0.85,blue:0.96))
                Text(message.text).font(.system(size:14)).textSelection(.enabled).fixedSize(horizontal:false,vertical:true).lineSpacing(3)
            }.frame(maxWidth:.infinity,alignment:.leading)
        }.padding(14)
            .background(isPlayer ? Color.white.opacity(0.035) : Color.purple.opacity(0.10),in:RoundedRectangle(cornerRadius:14))
            .overlay(RoundedRectangle(cornerRadius:14).strokeBorder(Color.white.opacity(0.045)))
    }
}
