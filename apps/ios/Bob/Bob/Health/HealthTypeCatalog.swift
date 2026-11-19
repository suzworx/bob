import HealthKit

// Explicit catalog from the Xcode 26.5 HealthKit SDK. New identifiers require review.
enum HealthTypeCatalog {
    static var samples: [HKSampleType] {
        var types: [HKSampleType] = []
        do {
            let identifiers: [String] = [
                "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
                "HKQuantityTypeIdentifierBodyFatPercentage",
                "HKQuantityTypeIdentifierBodyMass",
                "HKQuantityTypeIdentifierBodyMassIndex",
                "HKQuantityTypeIdentifierElectrodermalActivity",
                "HKQuantityTypeIdentifierHeight",
                "HKQuantityTypeIdentifierLeanBodyMass",
                "HKQuantityTypeIdentifierWaistCircumference",
                "HKQuantityTypeIdentifierActiveEnergyBurned",
                "HKQuantityTypeIdentifierAppleExerciseTime",
                "HKQuantityTypeIdentifierAppleMoveTime",
                "HKQuantityTypeIdentifierAppleStandTime",
                "HKQuantityTypeIdentifierBasalEnergyBurned",
                "HKQuantityTypeIdentifierCyclingCadence",
                "HKQuantityTypeIdentifierCyclingFunctionalThresholdPower",
                "HKQuantityTypeIdentifierCyclingPower",
                "HKQuantityTypeIdentifierCyclingSpeed",
                "HKQuantityTypeIdentifierDistanceCycling",
                "HKQuantityTypeIdentifierDistanceDownhillSnowSports",
                "HKQuantityTypeIdentifierDistanceSwimming",
                "HKQuantityTypeIdentifierDistanceWalkingRunning",
                "HKQuantityTypeIdentifierDistanceWheelchair",
                "HKQuantityTypeIdentifierFlightsClimbed",
                "HKQuantityTypeIdentifierNikeFuel",
                "HKQuantityTypeIdentifierPhysicalEffort",
                "HKQuantityTypeIdentifierPushCount",
                "HKQuantityTypeIdentifierRunningPower",
                "HKQuantityTypeIdentifierRunningSpeed",
                "HKQuantityTypeIdentifierStepCount",
                "HKQuantityTypeIdentifierSwimmingStrokeCount",
                "HKQuantityTypeIdentifierUnderwaterDepth",
                "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
                "HKQuantityTypeIdentifierEnvironmentalSoundReduction",
                "HKQuantityTypeIdentifierHeadphoneAudioExposure",
                "HKQuantityTypeIdentifierAtrialFibrillationBurden",
                "HKQuantityTypeIdentifierHeartRate",
                "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
                "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
                "HKQuantityTypeIdentifierPeripheralPerfusionIndex",
                "HKQuantityTypeIdentifierRestingHeartRate",
                "HKQuantityTypeIdentifierVO2Max",
                "HKQuantityTypeIdentifierWalkingHeartRateAverage",
                "HKQuantityTypeIdentifierAppleWalkingSteadiness",
                "HKQuantityTypeIdentifierRunningGroundContactTime",
                "HKQuantityTypeIdentifierRunningStrideLength",
                "HKQuantityTypeIdentifierRunningVerticalOscillation",
                "HKQuantityTypeIdentifierSixMinuteWalkTestDistance",
                "HKQuantityTypeIdentifierStairAscentSpeed",
                "HKQuantityTypeIdentifierStairDescentSpeed",
                "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
                "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
                "HKQuantityTypeIdentifierWalkingSpeed",
                "HKQuantityTypeIdentifierWalkingStepLength",
                "HKQuantityTypeIdentifierDietaryBiotin",
                "HKQuantityTypeIdentifierDietaryCaffeine",
                "HKQuantityTypeIdentifierDietaryCalcium",
                "HKQuantityTypeIdentifierDietaryCarbohydrates",
                "HKQuantityTypeIdentifierDietaryChloride",
                "HKQuantityTypeIdentifierDietaryCholesterol",
                "HKQuantityTypeIdentifierDietaryChromium",
                "HKQuantityTypeIdentifierDietaryCopper",
                "HKQuantityTypeIdentifierDietaryEnergyConsumed",
                "HKQuantityTypeIdentifierDietaryFatMonounsaturated",
                "HKQuantityTypeIdentifierDietaryFatPolyunsaturated",
                "HKQuantityTypeIdentifierDietaryFatSaturated",
                "HKQuantityTypeIdentifierDietaryFatTotal",
                "HKQuantityTypeIdentifierDietaryFiber",
                "HKQuantityTypeIdentifierDietaryFolate",
                "HKQuantityTypeIdentifierDietaryIodine",
                "HKQuantityTypeIdentifierDietaryIron",
                "HKQuantityTypeIdentifierDietaryMagnesium",
                "HKQuantityTypeIdentifierDietaryManganese",
                "HKQuantityTypeIdentifierDietaryMolybdenum",
                "HKQuantityTypeIdentifierDietaryNiacin",
                "HKQuantityTypeIdentifierDietaryPantothenicAcid",
                "HKQuantityTypeIdentifierDietaryPhosphorus",
                "HKQuantityTypeIdentifierDietaryPotassium",
                "HKQuantityTypeIdentifierDietaryProtein",
                "HKQuantityTypeIdentifierDietaryRiboflavin",
                "HKQuantityTypeIdentifierDietarySelenium",
                "HKQuantityTypeIdentifierDietarySodium",
                "HKQuantityTypeIdentifierDietarySugar",
                "HKQuantityTypeIdentifierDietaryThiamin",
                "HKQuantityTypeIdentifierDietaryVitaminA",
                "HKQuantityTypeIdentifierDietaryVitaminB12",
                "HKQuantityTypeIdentifierDietaryVitaminB6",
                "HKQuantityTypeIdentifierDietaryVitaminC",
                "HKQuantityTypeIdentifierDietaryVitaminD",
                "HKQuantityTypeIdentifierDietaryVitaminE",
                "HKQuantityTypeIdentifierDietaryVitaminK",
                "HKQuantityTypeIdentifierDietaryWater",
                "HKQuantityTypeIdentifierDietaryZinc",
                "HKQuantityTypeIdentifierBloodAlcoholContent",
                "HKQuantityTypeIdentifierBloodPressureDiastolic",
                "HKQuantityTypeIdentifierBloodPressureSystolic",
                "HKQuantityTypeIdentifierInsulinDelivery",
                "HKQuantityTypeIdentifierNumberOfAlcoholicBeverages",
                "HKQuantityTypeIdentifierNumberOfTimesFallen",
                "HKQuantityTypeIdentifierTimeInDaylight",
                "HKQuantityTypeIdentifierUVExposure",
                "HKQuantityTypeIdentifierWaterTemperature",
                "HKQuantityTypeIdentifierBasalBodyTemperature",
                "HKQuantityTypeIdentifierForcedExpiratoryVolume1",
                "HKQuantityTypeIdentifierForcedVitalCapacity",
                "HKQuantityTypeIdentifierInhalerUsage",
                "HKQuantityTypeIdentifierOxygenSaturation",
                "HKQuantityTypeIdentifierPeakExpiratoryFlowRate",
                "HKQuantityTypeIdentifierRespiratoryRate",
                "HKQuantityTypeIdentifierBloodGlucose",
                "HKQuantityTypeIdentifierBodyTemperature",
            ]
            types += identifiers.compactMap { HKObjectType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: $0)) }
        }
        if #available(iOS 18.0, *) {
            let identifiers: [String] = [
                "HKQuantityTypeIdentifierCrossCountrySkiingSpeed",
                "HKQuantityTypeIdentifierDistanceCrossCountrySkiing",
                "HKQuantityTypeIdentifierDistancePaddleSports",
                "HKQuantityTypeIdentifierDistanceRowing",
                "HKQuantityTypeIdentifierDistanceSkatingSports",
                "HKQuantityTypeIdentifierEstimatedWorkoutEffortScore",
                "HKQuantityTypeIdentifierPaddleSportsSpeed",
                "HKQuantityTypeIdentifierRowingSpeed",
                "HKQuantityTypeIdentifierWorkoutEffortScore",
                "HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances",
            ]
            types += identifiers.compactMap { HKObjectType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: $0)) }
        }
        do {
            let identifiers: [String] = [
                "HKCategoryTypeIdentifierAppleStandHour",
                "HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent",
                "HKCategoryTypeIdentifierHeadphoneAudioExposureEvent",
                "HKCategoryTypeIdentifierHighHeartRateEvent",
                "HKCategoryTypeIdentifierIrregularHeartRhythmEvent",
                "HKCategoryTypeIdentifierLowCardioFitnessEvent",
                "HKCategoryTypeIdentifierLowHeartRateEvent",
                "HKCategoryTypeIdentifierMindfulSession",
                "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
                "HKCategoryTypeIdentifierHandwashingEvent",
                "HKCategoryTypeIdentifierToothbrushingEvent",
                "HKCategoryTypeIdentifierCervicalMucusQuality",
                "HKCategoryTypeIdentifierContraceptive",
                "HKCategoryTypeIdentifierInfrequentMenstrualCycles",
                "HKCategoryTypeIdentifierIntermenstrualBleeding",
                "HKCategoryTypeIdentifierIrregularMenstrualCycles",
                "HKCategoryTypeIdentifierLactation",
                "HKCategoryTypeIdentifierMenstrualFlow",
                "HKCategoryTypeIdentifierOvulationTestResult",
                "HKCategoryTypeIdentifierPersistentIntermenstrualBleeding",
                "HKCategoryTypeIdentifierPregnancy",
                "HKCategoryTypeIdentifierPregnancyTestResult",
                "HKCategoryTypeIdentifierProgesteroneTestResult",
                "HKCategoryTypeIdentifierProlongedMenstrualPeriods",
                "HKCategoryTypeIdentifierSexualActivity",
                "HKCategoryTypeIdentifierSleepAnalysis",
                "HKCategoryTypeIdentifierAbdominalCramps",
                "HKCategoryTypeIdentifierAcne",
                "HKCategoryTypeIdentifierAppetiteChanges",
                "HKCategoryTypeIdentifierBladderIncontinence",
                "HKCategoryTypeIdentifierBloating",
                "HKCategoryTypeIdentifierBreastPain",
                "HKCategoryTypeIdentifierChestTightnessOrPain",
                "HKCategoryTypeIdentifierChills",
                "HKCategoryTypeIdentifierConstipation",
                "HKCategoryTypeIdentifierCoughing",
                "HKCategoryTypeIdentifierDiarrhea",
                "HKCategoryTypeIdentifierDizziness",
                "HKCategoryTypeIdentifierDrySkin",
                "HKCategoryTypeIdentifierFainting",
                "HKCategoryTypeIdentifierFatigue",
                "HKCategoryTypeIdentifierFever",
                "HKCategoryTypeIdentifierGeneralizedBodyAche",
                "HKCategoryTypeIdentifierHairLoss",
                "HKCategoryTypeIdentifierHeadache",
                "HKCategoryTypeIdentifierHeartburn",
                "HKCategoryTypeIdentifierHotFlashes",
                "HKCategoryTypeIdentifierLossOfSmell",
                "HKCategoryTypeIdentifierLossOfTaste",
                "HKCategoryTypeIdentifierLowerBackPain",
                "HKCategoryTypeIdentifierMemoryLapse",
                "HKCategoryTypeIdentifierMoodChanges",
                "HKCategoryTypeIdentifierNausea",
                "HKCategoryTypeIdentifierNightSweats",
                "HKCategoryTypeIdentifierPelvicPain",
                "HKCategoryTypeIdentifierRapidPoundingOrFlutteringHeartbeat",
                "HKCategoryTypeIdentifierRunnyNose",
                "HKCategoryTypeIdentifierShortnessOfBreath",
                "HKCategoryTypeIdentifierSinusCongestion",
                "HKCategoryTypeIdentifierSkippedHeartbeat",
                "HKCategoryTypeIdentifierSleepChanges",
                "HKCategoryTypeIdentifierSoreThroat",
                "HKCategoryTypeIdentifierVaginalDryness",
                "HKCategoryTypeIdentifierVomiting",
                "HKCategoryTypeIdentifierWheezing",
            ]
            types += identifiers.compactMap { HKObjectType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: $0)) }
        }
        if #available(iOS 18.0, *) {
            let identifiers: [String] = [
                "HKCategoryTypeIdentifierBleedingAfterPregnancy",
                "HKCategoryTypeIdentifierBleedingDuringPregnancy",
                "HKCategoryTypeIdentifierSleepApneaEvent",
            ]
            types += identifiers.compactMap { HKObjectType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: $0)) }
        }
        if #available(iOS 26.2, *) {
            let identifiers: [String] = [
                "HKCategoryTypeIdentifierHypertensionEvent",
            ]
            types += identifiers.compactMap { HKObjectType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: $0)) }
        }
        types += [HKObjectType.workoutType(), HKObjectType.audiogramSampleType(),
                  HKObjectType.electrocardiogramType(), HKObjectType.visionPrescriptionType(),
                  HKSeriesType.workoutRoute(), HKSeriesType.heartbeat()]
        if let document = HKObjectType.documentType(forIdentifier: .CDA) { types.append(document) }
        if #available(iOS 18.0, *) {
            types += [HKObjectType.stateOfMindType(), HKScoredAssessmentType(.GAD7), HKScoredAssessmentType(.PHQ9)]
        }
        if #available(iOS 26.0, *) { types.append(HKObjectType.medicationDoseEventType()) }
        types += [HKCorrelationTypeIdentifier.bloodPressure, .food]
            .compactMap { HKObjectType.correlationType(forIdentifier: $0) }
        return types
    }

    static var characteristics: [HKCharacteristicType] {
        [HKCharacteristicTypeIdentifier.biologicalSex, .bloodType, .dateOfBirth, .fitzpatrickSkinType, .wheelchairUse, .activityMoveMode]
            .compactMap { HKObjectType.characteristicType(forIdentifier: $0) }
    }

    static var allReadTypes: Set<HKObjectType> {
        var types = Set<HKObjectType>((samples.map { $0 as HKObjectType } + characteristics.map { $0 as HKObjectType }).filter { !($0 is HKCorrelationType) })
        types.insert(HKObjectType.activitySummaryType())
        if #available(iOS 26.0, *) { types.insert(HKObjectType.userAnnotatedMedicationType()) }
        return types
    }

    static var readTypes: Set<HKObjectType> {
        Set(allReadTypes.filter { !$0.requiresPerObjectAuthorization() })
    }

    static var clinical: [HKClinicalType] {
        [HKClinicalTypeIdentifier.allergyRecord, .clinicalNoteRecord, .conditionRecord, .immunizationRecord,
         .labResultRecord, .medicationRecord, .procedureRecord, .vitalSignRecord, .coverageRecord]
            .compactMap { HKObjectType.clinicalType(forIdentifier: $0) }
    }

    static func title(_ type: HKObjectType) -> String {
        let names = [
            "HKElectrocardiogramTypeIdentifier": "ECG recordings",
            "HKScoredAssessmentTypeIdentifierGAD7": "Anxiety assessments (GAD-7)",
            "HKScoredAssessmentTypeIdentifierPHQ9": "Depression assessments (PHQ-9)",
            "HKDataTypeIdentifierUserAnnotatedMedicationConcept": "Medications",
            "HKDocumentTypeIdentifierCDA": "Health documents (CDA)"
        ]
        if let name = names[type.identifier] { return name }
        let value = type.identifier
            .replacingOccurrences(of: "^HK(?:QuantityTypeIdentifier|CategoryTypeIdentifier|CharacteristicTypeIdentifier|DataTypeIdentifier|DocumentTypeIdentifier|ScoredAssessmentTypeIdentifier|ClinicalTypeIdentifier|MedicationDoseEventTypeIdentifier)?", with: "", options: .regularExpression)
            .replacingOccurrences(of: "TypeIdentifier", with: "")
            .replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
        return value
    }
}
