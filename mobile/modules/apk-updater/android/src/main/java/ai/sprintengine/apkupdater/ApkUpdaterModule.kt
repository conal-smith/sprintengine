package ai.sprintengine.apkupdater

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

// The native half of the phone's in-app updater (src/features/updates/). It
// does only what JavaScript cannot do cheaply or at all on Android:
//
//   installedApp()                  this install's versionCode, versionName and
//                                   signing certificate(s)
//   canRequestPackageInstalls()     whether "Install unknown apps" is on for us
//   sha256File(uri)                 a streamed SHA-256 of a downloaded APK, so an
//                                   80 MB file never has to sit in the JS heap
//   archiveInfo(uri)                the package name, versionCode and signing
//                                   certificate(s) of an APK on disk
//
// The decisions (is it newer, does the hash match, is the signer the release
// key, can it install over this one) are all made in apkUpdateLogic.ts, which
// is pure and covered by its regression test. Android-only: there is no iOS
// half, and the JS wrapper treats a missing module as "no updater here".
class ApkUpdaterModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("SprintEngineApkUpdater")

    Function("installedApp") {
      val pm = context.packageManager
      val info = packageInfo(pm, context.packageName)
      mapOf(
        "packageName" to context.packageName,
        "versionCode" to versionCodeOf(info).toDouble(),
        "versionName" to (info.versionName ?: ""),
        "signers" to signersOf(info),
      )
    }

    Function("canRequestPackageInstalls") {
      // Before Android 8 the switch was one global "Unknown sources" setting the
      // system installer asks about itself; there is nothing per-app to check.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
    }

    AsyncFunction("sha256File") { uri: String ->
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(fileOf(uri)).use { input ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          digest.update(buffer, 0, read)
        }
      }
      hex(digest.digest())
    }

    AsyncFunction("archiveInfo") { uri: String ->
      val path = fileOf(uri).absolutePath
      val pm = context.packageManager
      @Suppress("DEPRECATION")
      val flags =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
        } else {
          PackageManager.GET_SIGNATURES
        }
      val info = pm.getPackageArchiveInfo(path, flags) ?: return@AsyncFunction null
      mapOf(
        "packageName" to info.packageName,
        "versionCode" to versionCodeOf(info).toDouble(),
        "versionName" to (info.versionName ?: ""),
        "signers" to signersOf(info),
      )
    }
  }

  private fun fileOf(uri: String): File {
    val parsed = Uri.parse(uri)
    val path = if (parsed.scheme == "file") parsed.path else uri
    return File(path ?: throw IllegalArgumentException("Not a file URI: $uri"))
  }

  private fun packageInfo(pm: PackageManager, packageName: String): PackageInfo {
    @Suppress("DEPRECATION")
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES)
    } else {
      pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
    }
  }

  private fun versionCodeOf(info: PackageInfo): Long {
    @Suppress("DEPRECATION")
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
  }

  // SHA-256 of each certificate the APK is signed with now (not its past keys),
  // uppercase hex without separators. signingInfo is preferred; an archive read
  // on some Android 9 builds comes back without it, so the legacy array is the
  // fallback.
  private fun signersOf(info: PackageInfo): List<String> {
    val sha = MessageDigest.getInstance("SHA-256")
    val signingInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo else null
    @Suppress("DEPRECATION")
    val certificates =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && signingInfo != null) {
        signingInfo.apkContentsSigners
      } else {
        info.signatures
      }
    return certificates.orEmpty().map { hex(sha.digest(it.toByteArray())) }
  }

  private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02X".format(it) }
}
