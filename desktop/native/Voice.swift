import Foundation
import Speech
import AVFoundation

// The helper is owned by the desktop process. EOF releases the microphone.
final class VoiceHelper {
 let engine=AVAudioEngine(), speaker=AVSpeechSynthesizer()
 var task:SFSpeechRecognitionTask?, request:SFSpeechAudioBufferRecognitionRequest?
 var active:Int?, transcript="", tapped=false
 func emit(_ value:[String:Any]) { if let data=try? JSONSerialization.data(withJSONObject:value),let text=String(data:data,encoding:.utf8){print(text);fflush(stdout)} }
 func cancel(){active=nil;task?.cancel();task=nil;engine.stop();if tapped{engine.inputNode.removeTap(onBus:0);tapped=false};request?.endAudio();request=nil;speaker.stopSpeaking(at:.immediate)}
 func finish(){guard let id=active else{return};let text=transcript;cancel();emit(["type":"result","id":id,"text":text,"confidence":text.isEmpty ? 0 : 1])}
 func listen(_ id:Int){
  cancel();active=id;transcript=""
  SFSpeechRecognizer.requestAuthorization{status in
   DispatchQueue.main.async{
    guard self.active==id else{return}
    guard status == .authorized else{self.emit(["type":"error","id":id,"message":"Allow SoulStone speech recognition in System Settings."]);self.cancel();return}
    AVCaptureDevice.requestAccess(for:.audio){allowed in DispatchQueue.main.async{
     guard self.active==id else{return}
     guard allowed else{self.emit(["type":"error","id":id,"message":"Allow SoulStone microphone access in System Settings."]);self.cancel();return}
     self.record(id)
    }}
   }
  }
 }
 func record(_ id:Int){
  guard let recognizer=SFSpeechRecognizer(),recognizer.isAvailable else{emit(["type":"error","id":id,"message":"Speech recognition is unavailable. Check the Mac’s speech settings."]);cancel();return}
  let req=SFSpeechAudioBufferRecognitionRequest();req.shouldReportPartialResults=true;request=req
  let input=engine.inputNode, format=input.outputFormat(forBus:0)
  guard format.sampleRate>0&&format.channelCount>0 else{emit(["type":"error","id":id,"message":"Connect a microphone, then try again."]);cancel();return}
  input.installTap(onBus:0,bufferSize:1024,format:format){buffer,_ in req.append(buffer)};tapped=true
  task=recognizer.recognitionTask(with:req){result,error in DispatchQueue.main.async{
   guard self.active==id else{return}
   if let result=result{self.transcript=result.bestTranscription.formattedString;self.emit(["type":"transcript","id":id,"text":self.transcript]);if result.isFinal{self.finish();return}}
   if error != nil{self.emit(["type":"error","id":id,"message":"I didn’t catch that. Press Talk and try again."]);self.cancel()}
  }}
  do{try engine.start();emit(["type":"listening","id":id])}catch{emit(["type":"error","id":id,"message":"The microphone could not start."]);cancel()}
 }
 func command(_ value:[String:Any]){
  switch value["type"] as? String {
   case "listen":if let id=value["id"] as? Int{listen(id)}
   case "finish":finish()
   case "cancel":cancel()
   case "speak":speaker.stopSpeaking(at:.immediate);if let text=value["text"] as? String{let utterance=AVSpeechUtterance(string:text);utterance.rate=0.46;speaker.speak(utterance)}
   default:break
  }
 }
}
let voice=VoiceHelper()
voice.emit(["type":"ready","available":SFSpeechRecognizer() != nil])
DispatchQueue.global().async{
 while let line=readLine(){if line.utf8.count>10000{continue};if let data=line.data(using:.utf8),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any]{DispatchQueue.main.async{voice.command(value)}}}
 DispatchQueue.main.async{voice.cancel();exit(0)}
}
RunLoop.main.run()
