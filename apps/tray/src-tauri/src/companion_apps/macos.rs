use super::{App, Installation, Kind};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::NSString;
use std::path::{Path, PathBuf};

pub(super) fn detect(app: &App) -> Option<Installation> {
    let workspace = NSWorkspace::sharedWorkspace();
    app.bundle_ids.iter().find_map(|bundle_id| {
        let url =
            workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))?;
        let path = PathBuf::from(url.path()?.to_string());
        if !path.is_dir() {
            return None;
        }
        Some(Installation {
            bundle_id: bundle_id.clone(),
            kind: classify(&path),
            path,
        })
    })
}

fn classify(path: &Path) -> Kind {
    if path.join("Wrapper").is_dir() {
        return Kind::Ipad;
    }
    if plist::Value::from_file(path.join("Contents/Info.plist"))
        .ok()
        .and_then(|plist| plist.into_dictionary())
        .is_some_and(|dict| dict.contains_key("UIDeviceFamily"))
    {
        Kind::Catalyst
    } else {
        Kind::Mac
    }
}

pub(super) fn open(found: Installation) -> Result<(), String> {
    let mut child = std::process::Command::new("/usr/bin/open")
        .args(["-b", &found.bundle_id])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "Could not open the companion app.")?;
    if child.wait().is_ok_and(|status| status.success()) {
        Ok(())
    } else {
        Err("Could not open the companion app.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_application_bundles() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path();
        std::fs::create_dir(path.join("Contents")).unwrap();
        let info = path.join("Contents/Info.plist");
        let mut dict = plist::Dictionary::new();
        dict.insert("CFBundleIdentifier".into(), "org.example.app".into());
        plist::to_file_xml(&info, &dict).unwrap();
        assert_eq!(classify(path), Kind::Mac);

        dict.insert("UIDeviceFamily".into(), plist::Value::Array(vec![2.into()]));
        plist::to_file_binary(&info, &dict).unwrap();
        assert_eq!(classify(path), Kind::Catalyst);

        std::fs::create_dir(path.join("Wrapper")).unwrap();
        assert_eq!(classify(path), Kind::Ipad);
    }
}
