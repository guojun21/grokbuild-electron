import CoreGraphics
import Foundation

func writeJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: macos-probe.swift screen|windows <pid>\n".utf8))
    exit(64)
}

switch arguments[1] {
case "screen":
    try writeJSON(["screenRecording": CGPreflightScreenCaptureAccess()])
case "windows":
    guard arguments.count >= 3, let pid = Int(arguments[2]) else {
        FileHandle.standardError.write(Data("windows requires a pid\n".utf8))
        exit(64)
    }
    let raw = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] ?? []
    let windows: [[String: Any]] = raw.compactMap { item in
        guard (item[kCGWindowOwnerPID as String] as? Int) == pid,
              let number = item[kCGWindowNumber as String] as? Int,
              let bounds = item[kCGWindowBounds as String] as? [String: Any] else {
            return nil
        }
        return [
            "id": number,
            "name": item[kCGWindowName as String] as? String ?? "",
            "layer": item[kCGWindowLayer as String] as? Int ?? -1,
            "onScreen": item[kCGWindowIsOnscreen as String] as? Bool ?? false,
            "bounds": [
                "x": bounds["X"] as? Double ?? 0,
                "y": bounds["Y"] as? Double ?? 0,
                "width": bounds["Width"] as? Double ?? 0,
                "height": bounds["Height"] as? Double ?? 0,
            ],
        ]
    }
    try writeJSON(windows)
default:
    FileHandle.standardError.write(Data("unknown probe command: \(arguments[1])\n".utf8))
    exit(64)
}
