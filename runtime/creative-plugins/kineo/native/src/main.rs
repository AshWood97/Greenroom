use std::io::{self, Read};
use serde_json::{json, Value};
mod models { pub mod video_metadata; }
mod services { pub mod ffmpeg; pub mod video { pub mod analyzer; pub mod cutter; pub mod preview; pub mod transitions; pub mod manga_renderer; } }
mod utils { pub mod ffmpeg_utils; pub mod idgen; }
mod constants { pub mod allowed_dirs {
    pub fn temp_subdir(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("GREENROOM_PLUGIN_ROOT").expect("member root")).join("tmp").join(name)
    }
} }
fn style(value: &Value) -> kineo_ai::ArtStylePreset {
    match value.as_str().unwrap_or("modern_anime") {
        "xianxia"=>kineo_ai::ArtStylePreset::Xianxia,
        "cyberpunk"=>kineo_ai::ArtStylePreset::Cyberpunk,
        "shonen_action"=>kineo_ai::ArtStylePreset::ShonenAction,
        "dark_fantasy"=>kineo_ai::ArtStylePreset::DarkFantasy,
        _=>kineo_ai::ArtStylePreset::ModernAnime,
    }
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    let mut raw=String::new(); io::stdin().read_to_string(&mut raw).expect("input");
    let result: Result<Value,String> = async {
        let request:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        let args=&request["arguments"];
        match request["command"].as_str().unwrap_or("") {
            "parse_novel_to_script"=>Ok(json!(kineo_ai::parser::NovelScriptParser::parse_novel_to_script(args["text"].as_str().unwrap_or(""),style(&args["stylePreset"])))),
            "parse_direct_script"=>Ok(json!(kineo_ai::parser::NovelScriptParser::parse_direct_script(args["text"].as_str().unwrap_or("")))),
            "render_full_video"=>{
                let params=serde_json::from_value(args["params"].clone()).map_err(|e|e.to_string())?;
                Ok(json!(services::video::manga_renderer::render_full_manga_video(&params).await?))
            },
            "analyze_video"=>Ok(json!(services::video::analyzer::analyze(args["path"].as_str().ok_or("missing path")?)?)),
            "extract_key_frames"=>Ok(json!(services::video::analyzer::extract_key_frames(args["path"].as_str().ok_or("missing path")?,args["count"].as_u64().unwrap_or(5) as u32)?)),
            "generate_thumbnail"=>Ok(json!(services::video::analyzer::generate_thumbnail(args["path"].as_str().ok_or("missing path")?)?)),
            "cut_video"=>Ok(json!(services::video::cutter::cut(&serde_json::from_value(args["params"].clone()).map_err(|e|e.to_string())?)?)),
            "generate_preview"=>Ok(json!(services::video::preview::generate(&serde_json::from_value(args["params"].clone()).map_err(|e|e.to_string())?)?)),
            _=>Err("此桌面命令未开放为 Web 业务".into()),
        }
    }.await;
    match result {
        Ok(value)=>println!("{}",value),
        Err(error)=>{ eprintln!("{}",error); std::process::exit(1); }
    }
}
