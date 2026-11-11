plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

android {
    namespace = "ru.musichub.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.musichub.app"
        minSdk = 24
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
        ndk {
            // 64-битные и старые 32-битные телефоны ARM
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// Python-код приложения общий для ПК и телефона: копируем пакет musichub из music_player/.
val syncPython by tasks.registering(Sync::class) {
    from("../../musichub") { exclude("**/__pycache__/**") }
    into(layout.buildDirectory.dir("python-src/musichub"))
}
tasks.named("preBuild") { dependsOn(syncPython) }

chaquopy {
    defaultConfig {
        version = "3.12"
        pip {
            install("starlette")
            install("uvicorn")
            install("httpx")
            install("yt-dlp")
            install("yandex-music")
            install("mutagen")
            install("certifi")
        }
        // статические файлы интерфейса и сертификаты должны лежать на диске, а не внутри APK
        extractPackages("musichub", "certifi")
    }
    sourceSets {
        getByName("main") {
            srcDir("build/python-src")
        }
    }
}
