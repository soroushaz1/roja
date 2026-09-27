import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The website lives at the root of this repository. It is copied into the app's assets
// on every build, so the app always carries exactly the files the site serves — no
// second copy to keep in step.
abstract class CopyWebAssets : DefaultTask() {
    @get:Internal abstract val webRoot: DirectoryProperty
    @get:Input abstract val patterns: ListProperty<String>
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val files: FileSystemOperations

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    val webFiles: FileTree
        get() = webRoot.asFileTree.matching { include(patterns.get()) }

    @TaskAction
    fun copy() {
        files.sync {
            from(webRoot) { include(patterns.get()) }
            into(outputDir.dir("www"))
        }
    }
}

val siteFiles = listOf(
    "index.html", "*.js", "*.css", "favicon.svg", "fonts/**", "icons/**",
    "vendor/vision_bundle.js", "vendor/vision_bundle.mjs", "vendor/wasm/**", "vendor/face_landmarker.task",
    "vendor/LICENSE-Apache-2.0.txt", "LICENSE", "THIRD-PARTY.md"
)

// A stable signature needs your own key: see android/README.md. Without one, the
// release build is left unsigned and the debug APK is the one to install.
val keystore: String? = System.getenv("ROJA_KEYSTORE")

android {
    namespace = "com.roja.mirror"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.roja.mirror"
        minSdk = 26
        targetSdk = 35
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.0.$versionCode"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (keystore != null) create("release") {
            storeFile = file(keystore)
            storePassword = System.getenv("ROJA_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ROJA_KEY_ALIAS")
            keyPassword = System.getenv("ROJA_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    // The device test drops the repository's test portrait onto the mirror.
    sourceSets.getByName("androidTest").assets.srcDir(rootProject.projectDir.parentFile.resolve("tools"))
}

// One copy task per variant: the plugin sets each task's output folder to its own
// variant's generated-assets location.
androidComponents {
    onVariants { variant ->
        val copy = tasks.register<CopyWebAssets>("copy${variant.name.replaceFirstChar { it.uppercase() }}WebAssets") {
            webRoot.set(rootProject.projectDir.parentFile)
            patterns.set(siteFiles)
        }
        variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyWebAssets::outputDir)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
}
