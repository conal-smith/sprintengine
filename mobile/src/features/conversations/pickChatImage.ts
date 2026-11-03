import * as LegacyFileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";

import { bytesFromBase64, pictureTypeOf, type PickedImage } from "./composerOptions";
import { librarySelection, readPickedImages } from "./photoPicks";

/**
 * Pictures for a chat, from the library or the camera, as New and the chat
 * both pick them: null when the person cancels or there is no room, else the
 * pictures in the order they were picked and why any were left out. An error
 * says why none of them can be sent.
 *
 * The library lets the person pick as many as the message has room for
 * (`room`: what the tray can still hold), numbered in the order they were
 * tapped; the camera takes one. Multiple selection rules out the picker's
 * cropping, which is not asked for.
 *
 * The library is asked for its compatible form, so an iPhone's HEIC photo
 * arrives as a JPEG rather than as a type the desktop refuses, and each photo
 * is compressed as it is written. The type and size sent are then read off
 * the file the picker wrote, not taken from the picker's word for the original
 * photo: Android writes a compressed JPEG for a HEIC, GIF or WebP photo and
 * still reports the original's type and size. `maxBytes` is the largest the
 * desktop takes (`chatImageMaxBytes`), per picture.
 */
export async function pickChatImages(
  camera: boolean,
  maxBytes: number,
  room: number,
): Promise<{ images: PickedImage[]; problem: string | null } | null> {
  const selection = camera ? { allowsMultipleSelection: false, selectionLimit: 1 } : librarySelection(0, room);
  if (!selection) return null;
  const permission = camera
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error(camera ? "Camera access is required to take a photo." : "Photo access is required to attach an image.");
  }
  const result = camera
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 })
    : await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.85,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        allowsMultipleSelection: selection.allowsMultipleSelection,
        selectionLimit: selection.selectionLimit,
        orderedSelection: true,
      });
  const assets = result.canceled ? [] : (result.assets ?? []);
  if (!assets.length) return null;
  const picks = await Promise.all(assets.map(async (asset) => ({ asset, inspected: await inspectFile(asset.uri) })));
  const read = readPickedImages(picks, maxBytes, selection.selectionLimit);
  if (!read.images.length) throw new Error(read.problem ?? "The picture could not be added.");
  return read;
}

/** The written file's own type and size; whatever cannot be read is left to the picker's word. */
async function inspectFile(uri: string): Promise<{ type: string | null; size: number | null }> {
  const [head, info] = await Promise.all([
    LegacyFileSystem.readAsStringAsync(uri, {
      encoding: LegacyFileSystem.EncodingType.Base64,
      position: 0,
      length: 16,
    }).catch(() => null),
    LegacyFileSystem.getInfoAsync(uri).catch(() => null),
  ]);
  return {
    type: head ? pictureTypeOf(bytesFromBase64(head)) : null,
    size: info?.exists && typeof info.size === "number" ? info.size : null,
  };
}
