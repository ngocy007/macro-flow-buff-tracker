//! Fire-and-forget WAV playback on a dedicated thread (rodio's OutputStream is !Send).

use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};

#[derive(Clone)]
pub struct Audio {
    tx: Sender<(PathBuf, f32)>,
}

impl Audio {
    pub fn spawn() -> Audio {
        let (tx, rx) = channel::<(PathBuf, f32)>();
        std::thread::spawn(move || {
            let Ok((_stream, handle)) = rodio::OutputStream::try_default() else {
                eprintln!("[audio] không mở được thiết bị âm thanh");
                return;
            };
            while let Ok((path, volume)) = rx.recv() {
                let Ok(file) = File::open(&path) else {
                    eprintln!("[audio] không thấy file {}", path.display());
                    continue;
                };
                let Ok(dec) = rodio::Decoder::new(BufReader::new(file)) else {
                    eprintln!("[audio] không giải mã được {}", path.display());
                    continue;
                };
                if let Ok(sink) = rodio::Sink::try_new(&handle) {
                    sink.set_volume(volume.clamp(0.0, 2.0));
                    sink.append(dec);
                    sink.detach();
                }
            }
        });
        Audio { tx }
    }

    pub fn play(&self, path: PathBuf, volume: f32) {
        let _ = self.tx.send((path, volume));
    }
}
