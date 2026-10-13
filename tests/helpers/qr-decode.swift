// Test helper (macOS only): decodes QR module matrices with Apple's CoreImage detector, so
// tests/local-qr.test.ts checks src/local/qr.ts against an independent decoder.
// stdin: one code per line, "<size> <rows of 0/1 concatenated>"; stdout: the decoded text per line.
import CoreImage
import Foundation

while let line = readLine() {
  let parts = line.split(separator: " ")
  guard parts.count == 2, let size = Int(parts[0]) else { print("<bad input>"); continue }
  let bits = Array(parts[1])
  let scale = 8
  let quiet = 4
  let dim = (size + 2 * quiet) * scale
  var pixels = [UInt8](repeating: 255, count: dim * dim)
  for r in 0..<size {
    for c in 0..<size where bits[r * size + c] == "1" {
      for y in 0..<scale {
        for x in 0..<scale { pixels[((r + quiet) * scale + y) * dim + (c + quiet) * scale + x] = 0 }
      }
    }
  }
  let provider = CGDataProvider(data: Data(pixels) as CFData)!
  let cg = CGImage(
    width: dim, height: dim, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: dim,
    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0), provider: provider,
    decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
  let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
  let found = detector.features(in: CIImage(cgImage: cg)).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
  print(found.first ?? "<none>")
}
