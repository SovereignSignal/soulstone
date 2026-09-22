using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Web.Script.Serialization;

// Audio stays inside the Windows speech engine. Only text crosses this pipe.
public static class SoulStoneVoice {
 static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
 static readonly object OutputLock = new object();
 static readonly SpeechSynthesizer Speaker = new SpeechSynthesizer();
 static SpeechRecognitionEngine Engine;
 static void Emit(object value) { lock(OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
 static void Cancel() { Speaker.SpeakAsyncCancelAll(); var old=Engine;Engine=null;if(old!=null){old.RecognizeAsyncCancel();old.Dispose();} }
 // Short button phrases are easy for context-free dictation to confuse (for
 // example, "Follow me" with "Following"). Keep dictation for other requests.
 internal static SpeechRecognitionEngine CreateRecognizer(RecognizerInfo chosen) {
  var engine=new SpeechRecognitionEngine(chosen);
  try {
   engine.LoadGrammar(new DictationGrammar());
   if(chosen.Culture.TwoLetterISOLanguageName=="en") {
    var phrase=new GrammarBuilder();phrase.Culture=chosen.Culture;
    phrase.Append("please",0,1);
    phrase.Append(new Choices("follow me","get some wood","collect four oak logs","what are you carrying","what is in your bag","what's in your bag"));
    engine.LoadGrammar(new Grammar(phrase){Name="play-phrases"});
   }
   return engine;
  } catch {engine.Dispose();throw;}
 }
 static void Listen(int id) {
  Cancel();
  var installed=SpeechRecognitionEngine.InstalledRecognizers();
  var chosen=installed.FirstOrDefault(r=>r.Culture.Equals(CultureInfo.CurrentUICulture)) ?? installed.FirstOrDefault(r=>r.Culture.TwoLetterISOLanguageName=="en") ?? installed.FirstOrDefault();
  if(chosen==null)throw new InvalidOperationException("Ask a grown-up to install a Windows speech language in Settings, then reopen SoulStone.");
  var engine=CreateRecognizer(chosen);Engine=engine;
  var chunks=new List<string>();float confidence=1;
  engine.SpeechHypothesized+=(sender,e)=>{if(Engine==engine)Emit(new{type="transcript",id=id,text=e.Result.Text});};
  engine.SpeechRecognized+=(sender,e)=>{if(Engine!=engine)return;chunks.Add(e.Result.Text);confidence=Math.Min(confidence,e.Result.Confidence);Emit(new{type="transcript",id=id,text=String.Join(" ",chunks)});};
  engine.RecognizeCompleted+=(sender,e)=>{if(Engine!=engine)return;Engine=null;if(e.Error!=null)Emit(new{type="error",id=id,message="Ask a grown-up to check microphone access in Windows Settings."});else Emit(new{type="result",id=id,text=String.Join(" ",chunks),confidence=confidence});engine.Dispose();};
  engine.SetInputToDefaultAudioDevice();engine.RecognizeAsync(RecognizeMode.Multiple);Emit(new{type="listening",id=id});
 }
 public static void Main() {
  Console.InputEncoding=System.Text.Encoding.UTF8;Console.OutputEncoding=new System.Text.UTF8Encoding(false);
  try{Emit(new{type="ready",available=SpeechRecognitionEngine.InstalledRecognizers().Count>0});}
  catch{Emit(new{type="ready",available=false});}
  string line;
  while((line=Console.ReadLine())!=null)try{
   if(line.Length>10000)continue;
   var value=Json.Deserialize<Dictionary<string,object>>(line);var type=(string)value["type"];
   if(type=="listen")Listen(Convert.ToInt32(value["id"]));
   else if(type=="finish"){if(Engine!=null)Engine.RecognizeAsyncStop();}
   else if(type=="cancel")Cancel();
   else if(type=="speak"){Speaker.SpeakAsyncCancelAll();Speaker.SpeakAsync((string)value["text"]);}
  }catch{Cancel();Emit(new{type="error",message="Ask a grown-up to check the microphone and installed Windows speech language."});}
  Cancel();Speaker.Dispose();
 }
}
