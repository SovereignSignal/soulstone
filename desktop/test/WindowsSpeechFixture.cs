using System;
using System.IO;
using System.Linq;
using System.Globalization;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Web.Script.Serialization;
public class WindowsSpeechFixture {
 static string Normalize(string s){return new string((s??"").ToLowerInvariant().Where(c=>char.IsLetterOrDigit(c)||c==' ').ToArray());}
 public static int Main(string[] args) {
  var json=new JavaScriptSerializer();int failures=0,count=0;
  var chosen=SpeechRecognitionEngine.InstalledRecognizers().First(r=>r.Culture.Name=="en-US");
  bool baseline=args.Skip(1).Contains("baseline");
  string[] phrases={"Follow me","Get some wood","Collect four oak logs","What are you carrying","What is in your bag","Please follow me","Get some food","Follow bees","Please build a little house next to the water"};
  using(var speaker=new SpeechSynthesizer())foreach(var voice in speaker.GetInstalledVoices().Where(v=>v.Enabled&&v.VoiceInfo.Culture.Name=="en-US").Take(2)) {
   speaker.SelectVoice(voice.VoiceInfo.Name);
   for(int n=0;n<phrases.Length;n++) {
    string path=Path.Combine(args[0],"synthetic-"+(++count)+".wav");
    speaker.SetOutputToWaveFile(path);speaker.Speak(phrases[n]);speaker.SetOutputToNull();
    using(var engine=baseline?new SpeechRecognitionEngine(chosen):SoulStoneVoice.CreateRecognizer(chosen)) {
     if(baseline)engine.LoadGrammar(new DictationGrammar());
     engine.SetInputToWaveFile(path);var result=engine.Recognize(TimeSpan.FromSeconds(15));
     string text=result==null?null:result.Text;float confidence=result==null?0:result.Confidence;
     bool accepted=confidence>=0.55f;
     bool pass=n<6 ? accepted&&Normalize(text)==Normalize(phrases[n]) : !(accepted&&result.Grammar.Name=="play-phrases");
     if(!pass)failures++;
     Console.WriteLine(json.Serialize(new {baseline=baseline,passed=pass,input=phrases[n],text=text,confidence=confidence,accepted=accepted,grammar=result==null?null:result.Grammar.Name,voice=voice.VoiceInfo.Name,waveBytes=new FileInfo(path).Length,process64=Environment.Is64BitProcess}));
    }
   }
  }
  if(count==0)throw new InvalidOperationException("No English desktop voices are installed.");
  Console.WriteLine(json.Serialize(new{tests=count,failures=failures,baseline=baseline,source="production CreateRecognizer; synthetic audio only"}));return failures==0?0:1;
 }
}
