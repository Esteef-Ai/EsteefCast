import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The permanent release key lives outside the repo: <project>/secrets/keystore.properties
// (storeFile, storePassword, keyAlias, keyPassword). Without it, release builds fall back
// to the debug key so anyone can still build, but those APKs can't update the official ones.
val keystoreProps = Properties().apply {
    val f = rootProject.file("../secrets/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasReleaseKey = keystoreProps.getProperty("storeFile")?.let { file(it).exists() } == true

android {
    namespace = "ai.esteef.esteefcast"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.esteef.esteefcast"
        minSdk = 23
        targetSdk = 35
        versionCode = 4
        versionName = "0.3.1"
    }
    signingConfigs {
        if (hasReleaseKey) create("release") {
            storeFile = file(keystoreProps.getProperty("storeFile"))
            storePassword = keystoreProps.getProperty("storePassword")
            keyAlias = keystoreProps.getProperty("keyAlias")
            keyPassword = keystoreProps.getProperty("keyPassword")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (hasReleaseKey) "release" else "debug")
            // TVs and Fire TV sticks are ARM; the x86 libraries only matter for emulators (debug builds).
            ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("io.getstream:stream-webrtc-android:1.3.10")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
