// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 French catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: standard metropolitan French. Formal "vous" for
 * direct user-addressing (matches the formality typical in pro
 * GIS tools); imperative form for buttons ("Enregistrer," not
 * "Enregistrez").
 */
import type { CatalogShape } from '../locales';

export const fr: Partial<CatalogShape> = {
  common: {
    save: 'Enregistrer',
    cancel: 'Annuler',
    delete: 'Supprimer',
    close: 'Fermer',
    edit: 'Modifier',
    loading: 'Chargement…',
    backToItems: 'Retour aux éléments',
    settings: 'Paramètres',
    language: 'Langue',
  },
  nav: {
    items: 'Éléments',
    home: 'Accueil',
    admin: 'Administration',
    profile: 'Profil',
    signOut: 'Se déconnecter',
    signIn: 'Se connecter',
    overview: "Vue d'ensemble",
    folders: 'Dossiers',
    groups: 'Groupes',
    recentlyDeleted: 'Récemment supprimés',
    users: 'Utilisateurs',
    landingPage: "Page d'accueil",
    backup: 'Sauvegarde',
    housekeeping: 'Maintenance',
    notifications: 'Notifications',
    fieldQueues: 'Files de terrain',
    migrations: 'Migrations',
    gettingStarted: 'Premiers pas',
  },
  shell: {
    notificationsLabel: 'Notifications',
    navigation: 'Navigation',
    openNavigation: 'Ouvrir la navigation',
    closeNavigation: 'Fermer la navigation',
  },
  search: {
    placeholder: 'Rechercher des éléments...',
    label: 'Rechercher des éléments',
  },
  help: {
    buttonTitle: 'Aide (appuyez sur ? à tout moment)',
    openLabel: "Ouvrir l'aide",
  },
  newItem: {
    pageTitle: 'Créer un nouvel élément',
    pageIntro:
      "Choisissez ce que vous créez, puis remplissez les détails. Pour les services et les fichiers téléversés, nous rassemblerons les informations nécessaires sur l'écran suivant pour que l'élément soit prêt à l'emploi.",
    createButton: "Créer l'élément",
    backButton: 'Retour',
    viewerBlocked:
      "Votre compte a le rôle Lecteur, qui permet d'ouvrir et de télécharger des éléments mais pas d'en créer. Un administrateur de l'organisation peut changer votre rôle ou vous accorder uniquement la capacité de publication.",
  },
  newItemJob: {
    data_layer:
      'Commencez ici si vous avez une feuille de calcul, un shapefile ou un fichier GeoJSON à téléverser.',
    map: 'Commencez ici pour placer sur une carte des données déjà téléversées et la partager.',
    form: 'Commencez ici si vous voulez que des personnes saisissent des réponses, une à la fois, depuis un lien que vous leur envoyez.',
    data_collection:
      "Commencez ici si vous voulez qu'une équipe consigne sur une carte ce qu'elle trouve, depuis son téléphone, hors ligne.",
  },
  metadataXml: {
    intro:
      "Préremplir le titre, la description et les étiquettes à partir d'un fichier {term}, du type que ArcGIS, QGIS ou un catalogue de données public exporte avec un jeu de données. Reconnaît ISO 19115, FGDC CSDGM et Dublin Core.",
    term: 'XML de métadonnées',
    importTitle:
      'Importer un fichier XML de métadonnées exporté par ArcGIS, QGIS ou un catalogue de données (ISO 19115, FGDC CSDGM ou Dublin Core) pour préremplir les champs ci-dessous',
  },
  layerBuilder: {
    tableName: 'Nom de la table',
    tableNameTitle:
      'Le nom de cette couche dans la base de données et dans les adresses web. En minuscules, avec des tirets bas à la place des espaces.',
    dropToImport: 'Déposez pour importer.',
    dropHint: 'Déposez un fichier ici, ou cliquez pour en choisir un.',
    importUsual:
      'Le cas courant est une feuille de calcul enregistrée en CSV, avec une colonne de latitude et une colonne de longitude.',
    importAlso:
      'Aussi : TSV · GeoJSON · GeoParquet (.parquet) · KML / KMZ (Google Earth) · GeoPackage (.gpkg, tables vectorielles uniquement) · Shapefile (.zip) · File Geodatabase (.gdb.zip)',
  },
  mapEditor: {
    legendButton: 'Légende',
    tableButton: 'Table attributaire',
    markupButton: 'Annotations',
    commentsButton: 'Commentaires',
    printButton: 'Imprimer cette carte',
    layerAccessButton: 'Accès aux couches',
    saveMapButton: 'Enregistrer la carte',
    savedIndicator: 'Enregistré',
  },
  featureEdit: {
    groupLabel: 'Modifier',
    editShape: 'Modifier la forme',
    addFeature: 'Ajouter une entité',
    deleteFeature: "Supprimer l'entité",
    layerToAddTo: 'Couche cible',
    snappingOn: 'Accrochage activé',
    snappingOff: 'Accrochage désactivé',
    hintEdit:
      "Cliquez sur une entité d'une couche modifiable pour déplacer ses sommets.",
    hintLoading: "Chargement de l'entité...",
    hintDelete:
      "Cliquez sur une entité d'une couche modifiable pour la supprimer.",
    hintAddPoint: "Cliquez sur la carte pour placer l'entité.",
    hintAddPath:
      'Cliquez pour ajouter des sommets ; double-cliquez ou cliquez sur le premier sommet pour terminer.',
    editingIn:
      "Modification d'une entité dans {layer}. Faites glisser les sommets ; cliquez sur un point médian pour en ajouter un.",
    cancel: 'Annuler',
    saveShape: 'Enregistrer la forme',
    shapeSaved: 'Forme enregistrée.',
    featureAdded: 'Entité ajoutée.',
    featureDeleted: 'Entité supprimée.',
    newFeatureTitle: 'Nouvelle entité',
    newFeatureAttributes: 'Attributs de la nouvelle entité',
    addAction: "Ajouter l'entité",
    deleteConfirmTitle: 'Supprimer cette entité ?',
    deleteConfirmMessage:
      'Elle sera retirée de "{layer}". Cette action ne peut pas être annulée d\'ici.',
    deleteAction: 'Supprimer',
    noStableId:
      "Cette entité n'a pas d'identifiant stable et ne peut pas être modifiée ici.",
    noGeometry: "Cette couche n'a pas de géométrie à modifier.",
    notFound: 'Impossible de trouver cette entité sur le serveur.',
    loadFailed: "Impossible de charger l'entité",
    saveFailed: "Échec de l'enregistrement",
    deleteFailed: 'Échec de la suppression',
    addFailed: "Impossible d'ajouter l'entité",
    unnamedLayer: 'couche',
  },
  presence: {
    youSuffix: ' (vous)',
  },
  comments: {
    title: 'Commentaires',
    showResolved: 'Afficher les résolus',
    startThread: 'Démarrer un nouveau fil...',
    post: 'Publier',
    reply: 'Répondre...',
    resolve: 'Résoudre',
    reopen: 'Rouvrir',
    threadCount: '{count, plural, one {# fil} other {# fils}}',
    noOpen:
      "Aucun fil ouvert. Activez « Afficher les résolus » pour voir les fils fermés.",
    noComments:
      'Aucun commentaire pour le moment. Démarrez la conversation ci-dessous.',
    signInPrompt: 'Connectez-vous pour commenter cette carte.',
  },
  markup: {
    title: 'Annotations',
    add: 'Ajouter une annotation',
    empty:
      'Aucune annotation pour le moment. Ajoutez un ensemble, puis déposez des épingles pour annoter la carte.',
    dropPin: 'Déposer une épingle au centre',
    signInPrompt: 'Connectez-vous pour ajouter des annotations à cette carte.',
  },
  print: {
    chooserTitle: 'Imprimer cette carte',
    startSection: 'Créer une nouvelle mise en page',
    startAction:
      "Créer une nouvelle mise en page d'impression liée à cette carte",
    startHint:
      'Ouvre le concepteur de mise en page avec cette carte déjà connectée aux éléments Carte, Légende, Échelle et Rose des vents.',
    pickSection: 'Utiliser une mise en page existante',
    pickEmpty:
      "Aucune mise en page d'impression pour le moment. Utilisez « Créer une nouvelle mise en page » ci-dessus pour en créer une.",
  },
  errors: {
    generic: 'Une erreur est survenue',
    unauthorized: 'Connectez-vous pour continuer',
    notFound: 'Introuvable',
    sessionExpired:
      'Votre session a expiré. Reconnectez-vous pour retrouver tout ce à quoi vous avez accès.',
  },
  errorReason: {
    unknown: 'erreur inconnue',
  },
  addToFolder: {
    heading: 'Ajouter {count, plural, one {# élément} other {# éléments}} à un dossier',
    searchPlaceholder: 'Rechercher des dossiers',
    noMatches: 'Aucun dossier ne correspond.',
    itemCount: '{count, plural, one {# élément} other {# éléments}}',
  },
  areaSearch: {
    title: 'Rechercher par zone',
    hint: 'Déplacez et zoomez ; la liste se met à jour automatiquement.',
    close: 'Fermer la recherche par zone',
    myLocation: 'Ma position',
    myLocationTitle: 'Centrer la carte sur votre position actuelle',
    padAreaBy: 'Élargir la zone de',
    searching: 'Recherche...',
    refreshNow: 'Actualiser maintenant',
  },
  dataPreview: {
    title: 'Aperçu des données',
    eyebrow: 'Aperçu',
    openItem: "Ouvrir l'élément",
    closePreview: "Fermer l'aperçu",
    layer: 'Couche',
    layerLabel: 'Couche :',
    table: 'table',
    tableSuffix: '(table)',
    noFeatures: 'Aucune entité dans cette couche.',
    featureCount: '{count, plural, one {# entité} other {# entités}}',
    featureCountOverflow: '{count}+ parmi de nombreuses entités',
    fieldCount: '{count, plural, one {# champ} other {# champs}}',
    overflowNotice:
      "Affichage des {limit} premières entités. Ouvrez l'éditeur de carte de l'élément pour la table attributaire complète.",
    upstreamError: 'La source a renvoyé une erreur',
    loadFailed:
      "Impossible de charger l'aperçu. Ouvrez l'élément pour voir les détails.",
  },
  filter: {
    filter: 'Filtrer',
    filterItems: 'Filtrer les éléments',
    activeCount:
      '{count, plural, one {# filtre actif} other {# filtres actifs}}',
    type: 'Type',
    clearTypes: 'Effacer les types',
    noItemsToFilter: 'Aucun élément à filtrer dans la vue actuelle.',
    template: 'Modèle',
    owner: 'Propriétaire',
    access: 'Accès',
    area: 'Zone',
    clearArea: 'Effacer la zone',
    filterByArea: 'Filtrer par zone...',
    filteringByArea: 'Filtrage par zone',
    clearAll: 'Effacer tous les filtres',
  },
  folders: {
    hide: 'Masquer les dossiers',
  },
  folderRail: {
    newButton: '+ Nouveau',
    collapse: 'Réduire le dossier',
    expand: 'Développer le dossier',
    folderNamePlaceholder: 'Nom du dossier',
    emptyPrefix: 'Aucun dossier pour le moment.',
    createOne: 'Créez-en un',
    emptySuffix: 'pour organiser vos éléments.',
    moveFailedTitle: 'Échec du déplacement',
    moveFailedMessage: "Impossible de déplacer l'élément.",
  },
  folderMenu: {
    actionsFor: 'Actions pour {folder}',
    moreActions: "Plus d'actions",
    share: 'Partager...',
    newSubfolder: 'Nouveau sous-dossier',
    trashTitle: 'Déplacer le dossier vers la corbeille ?',
    trashMessage:
      'Déplacer "{folder}" vers la corbeille ? Le contenu du dossier reste en place ; seule l\'organisation en dossiers est supprimée.',
    trashMessageCascade:
      'Déplacer "{folder}" et les sous-dossiers listés vers la corbeille ? Les éléments qui ne sont pas des dossiers restent en place ; seule l\'organisation en dossiers est supprimée.',
    subfoldersAlsoTrashed:
      '{count, plural, one {# sous-dossier sera aussi déplacé vers la corbeille :} other {# sous-dossiers seront aussi déplacés vers la corbeille :}}',
    andMore: '...et {count} de plus.',
    unlinkedItems:
      "{count, plural, one {# autre élément à l'intérieur perdra sa référence au dossier, mais l'élément lui-même est conservé.} other {# autres éléments à l'intérieur perdront leur référence au dossier, mais les éléments eux-mêmes sont conservés.}}",
    multiParentNote:
      'Les sous-dossiers également classés dans un autre dossier survivront à cette suppression et ne sont pas listés.',
    trashing: 'Déplacement...',
    trashFailedTitle: 'Impossible de déplacer vers la corbeille',
    trashFailedMessage: 'Échec du déplacement vers la corbeille : {status}',
  },
  field: {
    nav: 'Terrain',
    qrAlt: 'Code QR menant à ce déploiement',
    qrHint:
      "Pointez l'appareil photo d'un téléphone dessus pour ouvrir le déploiement sur cet appareil.",
    qrSignIn:
      'La première fois, il vous sera demandé de vous connecter sur le téléphone.',
    copyLink: 'Copier le lien',
    copied: 'Copié',
    openOnPhone: 'Ouvrir sur un téléphone',
  },
  fieldQueue: {
    rejectedChip:
      '{count, plural, one {# modification à examiner} other {# modifications à examiner}}',
    rejectedChipTitle:
      'Le serveur a refusé ces modifications. Ouvrez pour voir pourquoi, puis réessayez ou abandonnez-les.',
    rejectedTitle: 'Modifications refusées par le serveur',
    rejectedIntro:
      'Ces modifications ont été envoyées mais pas acceptées, et les renvoyer telles quelles donnerait la même réponse. Corrigez ce que le message indique et réessayez, ou abandonnez la modification.',
    rejectedEmpty: 'Rien ici. Toutes les modifications ont été acceptées.',
    op: {
      insert: 'Nouvelle entité dans {layer}',
      update: 'Changement sur une entité dans {layer}',
      delete: 'Suppression dans {layer}',
    },
    unknownLayer: 'une couche qui ne fait plus partie de ce déploiement',
    noReason: "Le serveur n'a pas indiqué pourquoi.",
    retry: 'Réessayer',
    retryAll: 'Tout réessayer ({count})',
    discard: 'Abandonner',
    discardTitle: 'Abandonner cette modification ?',
    discardMessage:
      "Elle n'existe que sur cet appareil. Une fois abandonnée, elle ne peut pas être récupérée.",
    discardAction: 'Abandonner la modification',
    close: 'Fermer',
  },
  fieldAttachments: {
    heading: 'Photos et fichiers',
    headingCount: 'Photos et fichiers · {count}',
    add: 'Ajouter une photo',
    emptyCanCapture:
      "Aucune photo pour le moment. Elles sont conservées sur cet appareil et téléversées avec l'enregistrement.",
    emptyReadOnly: 'Aucune photo sur cet enregistrement.',
    pendingBadge: "Sur l'appareil",
    pendingBadgeTitle: 'En attente de téléversement',
    discardLabel: 'Abandonner {name}',
    discardTitle: 'Abandonner ce fichier ?',
    discardMessage:
      "{name} n'a pas encore été téléversé. L'abandonner le retire de cet appareil et il ne pourra pas être récupéré.",
    discardAction: 'Abandonner',
    quotaError:
      "Plus de place sur cet appareil pour une autre photo. Synchronisez ou libérez de l'espace d'abord.",
    saveError: "Impossible d'enregistrer le fichier : {reason}",
  },
  fieldCollect: {
    cancel: 'Annuler',
    submit: 'Envoyer',
    addTitle: 'Nouvelle entité : {layer}',
    editTitle: "Modifier l'entité : {layer}",
    addAria: 'Ajouter {layer}',
    editAria: 'Modifier {layer}',
    discardTitle: 'Abandonner cet enregistrement ?',
    discardMessage:
      "Vous avez saisi des informations qui n'ont pas été enregistrées. L'abandon est irréversible.",
    discardAction: 'Abandonner',
    discardCancel: 'Continuer la saisie',
  },
  fieldRuntime: {
    pickTypeSheet: "Choisissez un type d'entité à ajouter",
    featureDetailsSheet: "Détails de l'entité",
    queueReadFailed: 'Impossible de lire la file hors ligne.',
  },
  fieldGps: {
    accuracy: 'Précision GPS {meters} m',
    denied:
      'La localisation est bloquée. Autorisez-la dans les paramètres du navigateur pour capturer à votre position.',
    unavailable:
      'La localisation est indisponible sur cet appareil. Les entités seront placées au centre de la carte.',
  },
  fieldOffline: {
    partial: 'Incomplet. Non téléchargé : {missing}.',
    partialOutOfSpace:
      "Incomplet : plus d'espace de stockage. Non téléchargé : {missing}.",
    partialMissingMore: '{missing} et {count} de plus',
    quotaTitle: 'Pas assez de stockage pour ce téléchargement',
    quotaBody:
      "Ce téléchargement a besoin d'environ {needed} et il manque ~{short}. Libérez des déploiements en cache ou de l'espace sur l'appareil, ou réduisez le niveau de détail, puis réessayez.",
    identityTitle: "Travail non synchronisé d'un autre compte",
    identityBody:
      "Cet appareil contient {records, plural, one {# enregistrement non synchronisé} other {# enregistrements non synchronisés}} et {files, plural, one {# photo} other {# photos}} capturés par un autre compte. Ils n'ont pas atteint le serveur.",
    identityKeepExplain:
      'Si vous les gardez ici, ils restent en attente sur cet appareil, hors de vos compteurs de synchronisation, et sont envoyés quand ce compte se reconnecte.',
    identityRemoveExplain:
      "Si vous les retirez, ils sont supprimés de cet appareil. Rien d'autre n'en détient de copie.",
    identityKeep: 'Les garder ici',
    identityRemove: 'Les retirer de cet appareil',
    identityRemoved:
      '{records, plural, one {# enregistrement} other {# enregistrements}} et {files, plural, one {# photo} other {# photos}} retirés de cet appareil.',
    identityRemoveFailed: "Impossible de retirer les données de l'autre compte.",
    removeWillLose:
      '{count, plural, one {# modification non synchronisée sera perdue.} other {# modifications non synchronisées seront perdues.}}',
    removeWillLoseOthers:
      "{count, plural, one {# d'entre elles appartient à un autre compte.} other {# d'entre elles appartiennent à un autre compte.}}",
  },
  offlineMessage: {
    unknown:
      'Cet appareil a signalé quelque chose que ce portail ne reconnaît pas ({code}).',
    download: {
      estimating: 'Estimation de la taille du téléchargement...',
      estimated: 'Estimé à ~{size}',
      fetchingLayer: 'Récupération des entités de {layer}...',
      layerCached:
        '{layer} : {count, plural, one {# entité mise en cache} other {# entités mises en cache}}',
      layerHttpError: '{layer} a échoué avec le code HTTP {status}',
      layerMalformed: '{layer} a renvoyé une réponse mal formée',
      layerOutOfSpace: "{layer} n'a plus d'espace de stockage",
      layerFailed: '{layer} a échoué : {error}',
      fetchingForm: 'Récupération du formulaire {form}...',
      formHttpError: 'le formulaire {form} a échoué avec le code HTTP {status}',
      formNoSchema: "le formulaire {form}, qui n'a pas de schéma",
      formFailed: 'le formulaire {form}',
      fetchingPickList: 'Récupération de la liste de valeurs {pickList}...',
      pickListHttpError:
        'la liste de valeurs {pickList} a échoué avec le code HTTP {status}',
      pickListNoData: "la liste de valeurs {pickList}, qui n'a pas de données",
      pickListFailed: 'la liste de valeurs {pickList}',
      basemapOne: 'Téléchargement de la carte...',
      basemapNth: 'Téléchargement de la carte {index} sur {count}...',
      basemapOnePercent: 'Téléchargement de la carte : {percent} %',
      basemapNthPercent:
        'Téléchargement de la carte {index} sur {count} : {percent} %',
      basemapOneMegabytes: 'Téléchargement de la carte : {megabytes} Mo',
      basemapNthMegabytes:
        'Téléchargement de la carte {index} sur {count} : {megabytes} Mo',
      basemapOutOfSpace:
        "Échec du téléchargement de la carte : plus d'espace de stockage",
      basemapFailed: 'Échec du téléchargement de la carte : {error}',
      basemapAreaMissing: 'la carte de la zone {area}',
      cachingTiles: 'Mise en cache des tuiles du fond de carte...',
      tilesProgress: 'Mise en cache des tuiles : {fetched}/{total}',
      tilesRefused: '{reason}',
      tilesRefusedGeneric:
        'Le fournisseur du fond de carte ne permet pas les téléchargements hors ligne.',
      tilesCached: '{fetched} tuiles mises en cache ({failed} en échec)',
      tilesOutOfSpace:
        "Cache de tuiles : plus d'espace de stockage (poursuite en cours)",
      tilesFailed: 'Cache de tuiles : {error} (poursuite en cours)',
      tilesMissing:
        '{count, plural, one {# tuile du fond de carte} other {# tuiles du fond de carte}}',
      tilesMissingAll: 'les tuiles du fond de carte',
      saving: 'Enregistrement du manifeste du déploiement...',
      layers: '{count, plural, one {# couche} other {# couches}}',
      detailFeatures: '{count, plural, one {# entité} other {# entités}}',
      detailForms: '{count, plural, one {# formulaire} other {# formulaires}}',
      detailPickLists:
        '{count, plural, one {# liste de valeurs} other {# listes de valeurs}}',
      done: '{layers} mises en cache ({detail}).',
      doneEmpty:
        '{layers} mises en cache. La synchronisation reste à jour au fur et à mesure que des entités sont ajoutées.',
      donePartial: 'Incomplet. Non téléchargé : {missing}. {summary}',
      donePartialOutOfSpace:
        "Incomplet : plus d'espace de stockage. Non téléchargé : {missing}. Libérez de l'espace et téléchargez à nouveau.",
      missingMore: '{missing} et {count} de plus',
      failed: 'Échec du téléchargement',
    },
    sync: {
      networkUnavailable: 'Pas de connexion.',
      networkUnavailableDetail: 'Pas de connexion : {error}',
      unknownOp:
        "Cette modification utilise une opération que cette version de l'application ne connaît pas ({op}).",
      fileTooLarge:
        '{fileName} pèse {sizeMb} Mo et la limite est de {limitMb} Mo.',
      serverRefused: '{serverMessage}',
      serverRefusedWithStatus: '{serverMessage} ({status})',
      requestFailed: "Le serveur n'a pas accepté cette modification ({status}).",
      attachmentPresignFailed:
        "Impossible de démarrer l'envoi du fichier ({status}).",
      attachmentUploadFailed: "Impossible d'envoyer le fichier ({status}).",
      attachmentRegisterFailed:
        "Le fichier a été envoyé mais le portail ne l'a pas enregistré ({status}).",
      unexpected: "Une erreur s'est produite : {error}",
    },
  },
  signOut: {
    unsyncedTitle: 'Se déconnecter avec du travail non synchronisé ?',
    unsyncedMessage:
      "{count, plural, one {# modification sur cet appareil n'a pas encore atteint le serveur. Elle restera sur cet appareil, mais personne d'autre ne peut l'envoyer à votre place.} other {# modifications sur cet appareil n'ont pas encore atteint le serveur. Elles resteront sur cet appareil, mais personne d'autre ne peut les envoyer à votre place.}} Synchronisez avant de vous déconnecter si vous pouvez obtenir une connexion.",
    unsyncedConfirm: 'Se déconnecter quand même',
    unsyncedCancel: 'Rester connecté',
  },
  itemDetail: {
    accessPrivate: 'Privé',
    accessOrg: 'Organisation',
    accessPublic: 'Public',
    accessPrivateTitle:
      'Seulement vous et les personnes avec qui vous le partagez',
    accessOrgTitle: 'Toute personne connectée à ce portail',
    accessPublicTitle: "N'importe qui sur internet, sans connexion",
    licenseTitle: 'Licence : {license}',
    statFeatures: 'Entités',
    statGeometry: 'Forme',
    statCoordinates: 'Coordonnées',
    statFields: 'Champs',
    statLayers: 'Couches',
    statUpdated: 'Mis à jour',
    statFeaturesTitle:
      'Comptées en direct et limitées à ce à quoi vous avez accès, donc parfois inférieures au total publié.',
    statCoordinatesTitle:
      'Stockées en latitude et longitude (EPSG:4326). {source}',
    statCoordinatesFrom: "Converties depuis {srs} lors de l'import.",
    statCoordinatesNative: "C'est ainsi qu'elles sont arrivées.",
    statCoordinatesUnknown:
      "Le fichier source ne le précisait pas, on a donc supposé qu'il s'agissait déjà de latitude et longitude.",
    statUnavailable: 'Non disponible',
    statMixed: 'Mixte',
    geometryPoint: 'Points',
    geometryLine: 'Lignes',
    geometryPolygon: 'Surfaces',
    geometryNone: 'Table, sans formes',
    previewTitle: 'Aperçu',
    previewEmpty: 'Rien à dessiner pour le moment',
    previewEmptyHint:
      "Cette couche n'a aucune entité localisée, il n'y a donc rien à afficher sur une carte.",
    previewFailed: "L'aperçu n'a pas pu être chargé",
    previewLoading: "Chargement de l'aperçu",
  },
  itemTabs: {
    overview: "Vue d'ensemble",
    data: 'Données',
    structure: 'Structure',
    source: 'Source',
    metadata: 'Métadonnées',
    access: 'Partager',
    sections: "Sections de l'élément",
  },
  mapCard: {
    editTitle: 'Carte',
    editBody:
      'Ouvrez la carte pour vous déplacer, zoomer et parcourir la table attributaire, ainsi que pour ajouter des couches, définir le fond de carte et organiser le canevas.',
    editAction: 'Ouvrir la carte',
    viewTitle: 'Carte',
    viewBody:
      "Ouvrez cette carte pour vous déplacer, zoomer, changer de fond de carte et parcourir la table attributaire. Vous avez un accès en lecture, donc rien de ce que vous changez ici n'est enregistré.",
    viewAction: 'Ouvrir la carte',
  },
  appCard: {
    editTitle: 'Application web personnalisée',
    editBody:
      'Ouvrez le constructeur pour glisser des widgets sur le canevas, organiser les pages et lier des couches de données.',
    editAction: 'Ouvrir le constructeur',
    viewTitle: 'Application web',
    viewBody:
      'Ouvrez cette application et utilisez-la telle que ses lecteurs la voient.',
    viewAction: "Ouvrir l'application",
  },
  groupItems: {
    title: 'Partagé avec ce groupe',
    empty:
      "Rien n'est encore partagé avec ce groupe. Partagez un élément avec le groupe depuis son onglet Partager et il apparaîtra ici.",
    openItem: "Ouvrir les détails de l'élément",
    removeAction: 'Retirer de ce groupe',
    removeTitle: 'Retirer du groupe',
    removeBody:
      'Retirer "{title}" de ce groupe ? Les membres du groupe perdent l\'accès accordé par ce partage ; l\'élément lui-même n\'est pas touché.',
    removeConfirm: 'Retirer',
    removed: '"{title}" retiré du groupe.',
    removeFailed: "Impossible de retirer l'élément : HTTP {status}.",
  },
  housekeepingTabs: {
    review: 'Revue',
    cleanup: 'Nettoyage',
    starters: 'Modèles de départ',
    schedule: 'Planification',
    sections: 'Sections de maintenance',
  },
  v3Editor: {
    structureTitle: 'Structure de la couche',
    structureIntro:
      "Modifiez ici les couches, les champs, les domaines et les contraintes. L'enregistrement prend effet immédiatement ; l'import et la consultation des lignes se trouvent dans l'onglet Données.",
    dataTitle: 'Données de la couche',
    dataIntro:
      'Parcourez les lignes de chaque couche, ajoutez des données ou téléchargez-les.',
  },
  layerExport: {
    format: {
      csv: 'CSV',
      xlsx: 'Excel',
      geojson: 'GeoJSON',
      geoparquet: 'GeoParquet',
    },
    exported:
      '{count, plural, one {# ligne exportée} other {# lignes exportées}} en {format}.',
    failed: "Échec de l'export {format}",
    nothingLoaded: "Rien à exporter : cette couche n'a aucune ligne chargée.",
    nothingSelected: "Rien à exporter : aucune ligne n'est sélectionnée.",
    exportRows: 'Exporter {count, plural, one {# ligne} other {# lignes}}',
    noRows: 'Aucune ligne à exporter',
  },
  addToMap: {
    newMap: 'Nouvelle carte',
    existingMap: 'Une carte existante',
    loadingMaps: 'Chargement des cartes...',
    noMaps: 'Aucune carte pour le moment',
    layerGone: '{item} n\'a plus de couche "{layerKey}".',
    tableNoShapes:
      "{layer} est une table sans formes, il n'y a donc rien à dessiner.",
  },
  mapSearch: {
    geocoderUnavailable:
      'La recherche de lieux est indisponible pour le moment ({reason}). Les résultats de couches ci-dessus ne sont pas affectés.',
    noPlaces:
      'Aucun lieu trouvé pour cela. Le géocodeur de ce portail ne couvre que la zone pour laquelle il a été configuré.',
  },
  adminFieldQueues: {
    rejectedByServer: '{count} refusés par le serveur',
    queuedSummary: '{queued} en file ({failed} en échec)',
    queuedSummaryWithRejected:
      '{queued} en file ({failed} en échec, {rejected} refusés)',
    rejectedWaiting: 'refusé, en attente du worker',
    moreWithErrors: '+ {count} autres enregistrements en erreur.',
  },
  metadataPanel: {
    description: 'Description',
    noDescription:
      "Aucune description pour le moment. Une phrase sur ce que c'est et d'où cela vient fait la différence entre un élément que quelqu'un réutilise et un élément que quelqu'un recrée.",
    tags: 'Étiquettes',
    noTags: 'Aucune étiquette.',
    type: 'Type',
    owner: 'Propriétaire',
    created: 'Créé',
    updated: 'Mis à jour',
    license: 'Licence',
    source: 'Source',
    sourceFormat: 'Format source',
    originalProjection: "Projection d'origine",
    itemId: "Identifiant de l'élément",
    storageScope: 'Portée de stockage',
    storageScopeFor: 'Portée : {layer}',
    storageTable: 'Table de stockage',
    notRecorded: 'Non renseigné',
    copyTitle: 'Copier {label}',
    formatGeojson: 'GeoJSON',
    formatGeoparquet: 'GeoParquet',
    formatKml: 'KML',
    formatKmz: 'KMZ',
    formatShapefile: 'Shapefile',
    formatGdb: 'Géodatabase fichier',
    formatXlsx: 'Classeur Excel',
    formatCsv: 'CSV',
    formatManual: 'Saisi à la main',
    formatApi: "Chargé via l'API",
  },
  copyButton: {
    copy: 'Copier',
    copied: 'Copié',
  },
  offlineAreas: {
    title: 'Zones hors ligne',
    intro:
      "Le portail prépare un fichier de carte par zone, de sorte qu'un comté entier est un seul téléchargement de quelques mégaoctets plutôt qu'un million de requêtes séparées.",
    addArea: 'Ajouter une zone',
    loading: 'Chargement des zones...',
    noneYet: 'Aucune zone pour le moment.',
    noneYetNoExtent:
      "Ajoutez d'abord des données à la carte déployée, pour qu'il y ait une emprise à préparer.",
    noneYetHint:
      'Ajoutez-en une et les collecteurs pourront emporter ce déploiement hors ligne.',
    extentSummary: 'environ {width} sur {height} miles',
    rebuildsEvery: 'reconstruite tous les {days} jours',
    waiting: 'En attente de démarrage...',
    preparingCount: 'Préparation de {count} tuiles...',
    preparing: 'Préparation...',
    ready: 'Prête',
    builtOn: 'construite le {date}',
    buildFailed: "N'a pas pu être préparée.",
    notPrepared: 'Pas encore préparée.',
    prepareAgain: 'Préparer à nouveau',
    prepareNow: 'Préparer maintenant',
    deleteArea: 'Supprimer la zone',
    deleteTitle: 'Supprimer cette zone ?',
    deleteBody:
      'Les collecteurs ne pourront plus télécharger "{name}". Ce qui est déjà sur un appareil y reste.',
    name: 'Nom',
    namePlaceholder: "Relevé d'été, équipe nord...",
    detailLabel: 'Niveau de détail',
    detailHint:
      "Les collecteurs peuvent toujours zoomer au-delà. Passé un certain point, la carte cesse simplement d'ajouter de nouvelles étiquettes.",
    refreshLabel: 'Garder à jour',
    refreshManual: 'Seulement à ma demande',
    refreshWeekly: 'Chaque semaine',
    refreshMonthly: 'Chaque mois',
    refreshQuarterly: 'Tous les trois mois',
    detailRoads: 'Routes et villes',
    detailRoadsHint: 'Téléchargement le plus léger',
    detailStreets: 'Rues locales',
    detailPaths: 'Noms de rues et chemins',
    detailPathsHint: 'Recommandé pour le terrain',
    detailBuildings: 'Contours des bâtiments',
    detailBuildingsHint: 'Téléchargement le plus lourd',
    tooBig:
      'Cette zone est trop grande à ce niveau de détail. Choisissez moins de détail, ou divisez le déploiement en plusieurs zones.',
    sizeEstimate:
      'Couvre {extent}. Environ {size} à télécharger. Le chiffre exact est mesuré avant toute préparation.',
    cancel: 'Annuler',
    addAndPrepare: 'Ajouter et préparer',
    saveFailed: "Impossible d'enregistrer la zone : {status}",
    buildStartFailed: 'Impossible de démarrer la construction : {status}',
  },
  offlineBasemap: {
    preparedMap: 'Carte préparée',
    preparedMaps: 'Cartes préparées',
    onThisDevice: 'Sur cet appareil',
    includedWithSize: '{size}, inclus dans le téléchargement ci-dessus',
    included: 'Inclus dans le téléchargement ci-dessus',
    removeFromDevice: 'Retirer de cet appareil',
    removeAria: 'Retirer {name} de cet appareil',
    explainer:
      "Votre chef d'équipe a préparé ces cartes : elles arrivent donc en fichiers uniques plutôt que morceau par morceau, et s'affichent sans aucun réseau.",
    unsupported:
      "Ce navigateur ne peut pas stocker de cartes hors ligne. Essayez d'ajouter l'application à votre écran d'accueil.",
    preparedNoticeOne:
      'La carte de ce déploiement est déjà préparée, elle arrive donc en un seul fichier.',
    preparedNoticeMany:
      'Les cartes de ce déploiement sont déjà préparées, elles arrivent donc en fichiers uniques.',
    downloadStopped:
      'Téléchargement arrêté. Ce qui est déjà enregistré reste sur cet appareil.',
  },
  itemMenu: {
    actions: "Actions de l'élément",
    open: 'Ouvrir',
    responses: 'Réponses',
    configure: 'Configurer',
    previewData: 'Aperçu des données',
    addToMap: 'Ajouter à une carte',
    addLayerToMapTitle: 'Ajouter uniquement cette couche à une carte',
    moveToFolder: 'Déplacer vers un dossier',
    removeFromFolder: 'Retirer de ce dossier',
    removeFromNamedFolder: 'Retirer de "{folder}"',
  },
  itemForm: {
    itemType: "Type d'élément",
    title: 'Titre',
    titlePlaceholder: 'Ma couche, mon rapport, mon formulaire...',
    titleRequired: 'Le titre est obligatoire.',
    description: 'Description',
    descriptionPlaceholder: "Qu'est-ce que c'est, et pour qui ?",
    tags: 'Étiquettes',
    tagsPlaceholder: 'Séparées par des virgules, p. ex. bâtiments, parcelles, campus',
    tagsHint: 'Utilisées pour la recherche et le filtrage.',
    thumbnail: 'Vignette',
    visibility: 'Visibilité',
    visibilityHintCreate:
      "Vous pouvez modifier cela plus tard et ajouter des partages explicites depuis la page de détails de l'élément.",
    visibilityHintEdit:
      'Affinez avec des partages par utilisateur ou par groupe depuis la page de détails.',
    license: 'Licence',
    licenseHintPrefix:
      "Comment les autres sont autorisés à réutiliser cet élément. Affiché dans le catalogue de données ouvertes de l'organisation",
    licenseHintSuffix: 'pour les éléments publics.',
    licenseCustomPlaceholder:
      'Identifiant SPDX ou URL de licence (p. ex. https://creativecommons.org/licenses/by/4.0/)',
    recipe: 'Recette',
    pickSourceLayer:
      'Choisissez une couche de données source pour cette couche dérivée.',
    addPipelineStep: "Ajoutez au moins une étape d'outil au pipeline.",
    saveFailed: '{method} a échoué : {status} {detail}',
    saveChanges: 'Enregistrer les modifications',
    type: {
      map: {
        label: 'Carte',
        desc: 'Un fond de carte + des couches superposées avec styles.',
      },
      data_layer: {
        label: 'Couche de données',
        desc: 'Une couche vectorielle partageable appuyée sur PostGIS.',
      },
      arcgis_service: {
        label: 'Service ArcGIS',
        desc: 'Pointeur en direct vers un MapServer ou FeatureServer ArcGIS.',
      },
      form: {
        label: 'Formulaire',
        desc: 'Un formulaire de collecte pour le terrain ou les enquêtes.',
      },
      web_app: {
        label: 'Application web',
        desc: 'Une application configurable construite avec des widgets.',
      },
      report_template: {
        label: 'Modèle de rapport',
        desc: 'Un modèle de document qui met en forme des données.',
      },
      dashboard: {
        label: 'Tableau de bord',
        desc: 'Des panneaux en direct affichant les données des entités.',
      },
      file: {
        label: 'Fichier',
        desc: 'Tout fichier téléversé (PDF, image, zip, etc.).',
      },
    },
    access: {
      private: {
        label: 'Privé',
        desc: 'Seulement vous et les personnes avec qui vous partagez.',
      },
      org: {
        label: 'Votre organisation',
        desc: 'Toute personne disposant d\'un compte dans votre organisation.',
      },
      public: { label: 'Public', desc: "N'importe qui sur internet." },
    },
    licenseOption: {
      notSpecified: {
        label: 'Non précisée',
        hint: 'Traitée comme "droits réservés"',
      },
      cc0: { label: 'CC0 (domaine public)', hint: 'Aucun droit réservé' },
      ccBy: { label: 'CC BY 4.0', hint: 'Réutilisation avec attribution' },
      ccBySa: {
        label: 'CC BY-SA 4.0',
        hint: 'Attribution + partage dans les mêmes conditions',
      },
      ccByNc: { label: 'CC BY-NC 4.0', hint: 'Attribution, non commercial' },
      oglUk: {
        label: 'Licence gouvernement ouvert du Royaume-Uni v3',
        hint: '',
      },
      odbl: { label: 'Open Database License 1.0', hint: '' },
      mit: {
        label: 'MIT',
        hint: 'Permissive ; courante aussi pour les jeux de données',
      },
      proprietary: {
        label: 'Propriétaire / droits réservés',
        hint: 'Usage interne uniquement',
      },
      custom: { label: 'Personnalisée…', hint: 'Précisez votre propre valeur' },
    },
  },
  items: {
    share: 'Partager',
    adding: 'Ajout...',
    addToFolder: 'Ajouter à un dossier',
    addToNamedFolder: 'Ajouter à {folder}',
    addToFolderFailed: "Échec de l'ajout au dossier",
    removeFromFolderFailed: 'Échec du retrait du dossier',
    folderLoadFailed: 'Impossible de charger le dossier : HTTP {status}',
    moveToTrash: 'Déplacer vers la corbeille',
    movingProgress: 'Déplacement...',
    sharingProgress: 'Partage...',
    searchFailed: 'La recherche a échoué',
    reassignFailed: 'Échec de la réattribution',
    addingItemsTo: 'Ajout d\'éléments à :',
    addingItemsHint:
      'Cochez les éléments ci-dessous et cliquez sur "Ajouter à {folder}".',
    selected: 'sélectionnés',
    selectedItem: 'Élément sélectionné',
    clear: 'Effacer',
    clearFilter: 'Effacer le filtre {filter}',
    selectAll: 'Sélectionner tous les éléments gérables de ce groupe',
    selectItem: 'Sélectionner {title}',
    reassignOwner: 'Réattribuer le propriétaire',
    reassignHeading:
      'Réattribuer {count, plural, one {# élément} other {# éléments}}',
    reassignSubheading:
      'Choisissez le nouveau propriétaire ; les partages existants de chaque élément sont conservés.',
    bulkTrashTitle: 'Déplacer les éléments sélectionnés vers la corbeille',
    bulkTrashHeading:
      'Déplacer {count, plural, one {# élément} other {# éléments}} vers la corbeille ?',
    bulkTrashBody:
      '{count, plural, one {L\'élément sélectionné sera déplacé vers la corbeille.} other {Les éléments sélectionnés seront déplacés vers la corbeille.}} Vous pouvez les restaurer depuis la page "Supprimés récemment".',
    skippedHint:
      "Les éléments dont vous n'êtes ni propriétaire ni administrateur sont ignorés automatiquement.",
    bulkTrashNoneMoved:
      "Aucun élément déplacé vers la corbeille. Vous n'avez peut-être pas les droits d'administration sur les éléments sélectionnés.",
    bulkTrashPartial:
      "{done} éléments déplacés vers la corbeille ; {skipped} ignorés (pas de droits d'administration).",
    bulkShareNoneWritten:
      "Aucun partage n'a été écrit. Vous n'avez peut-être pas les droits d'administration sur les éléments sélectionnés.",
    bulkSharePartial:
      "{done} éléments partagés ; {skipped} ignorés (pas de droits d'administration).",
    bulkAccessNoneUpdated:
      "Aucun élément n'a été mis à jour. Vous n'avez peut-être pas les droits d'administration sur les éléments sélectionnés.",
    bulkAccessPartial:
      "{done} éléments mis à jour ; {skipped} ignorés (pas de droits d'administration).",
    shareSelectedTitle: 'Partager les éléments sélectionnés',
    shareSelectedBody:
      "Chacun des {count} éléments sélectionnés reçoit son propre partage pour le destinataire que vous choisissez. Les éléments dont vous n'êtes ni propriétaire ni administrateur sont ignorés automatiquement.",
    shareTabPrincipal: 'Utilisateur ou groupe',
    shareTabOrg: 'Org.',
    shareOrgBody:
      "Toute personne connectée à votre organisation pourra voir les {count} éléments sélectionnés. Cela élève le niveau d'accès de l'élément ; les partages utilisateur / groupe existants sont conservés.",
    sharePublicBody:
      "N'importe qui sur internet pourra voir les {count} éléments sélectionnés sans se connecter. Utilisez ceci pour des liens partageables de cartes / visionneuses. Les éléments référencés par la sélection (couches, fonds de carte, etc.) doivent aussi être publics ; il vous sera proposé de propager ce choix une fois terminé.",
    geographicScope: 'Portée géographique',
    noBoundaryItems: "Aucun élément de limite dans cette organisation pour l'instant",
    noScope: 'Aucune portée (sans restriction)',
    geoScopeHint:
      "Une fois définie, les personnes accédant à ces éléments via {via} ne voient que les entités à l'intérieur de la limite. Appliqué au niveau de l'API.",
    geoScopeViaOrg: 'votre organisation',
    geoScopeViaPublic: "l'accès public",
    recipient: 'Destinataire',
    groupTag: 'groupe',
    searchUserOrGroup: 'Rechercher un utilisateur ou un groupe',
    noMatchingUsersOrGroups: 'Aucun utilisateur ni groupe correspondant.',
    startTypingName: 'Commencez à saisir un nom pour rechercher.',
    permission: 'Autorisation',
    permissionDesc: {
      view: "Voir l'élément",
      download: 'Voir + exporter les données en masse',
      edit: 'Voir + modifier le contenu',
      admin: 'Contrôle total, y compris le partage',
    },
    makeOrgVisible: "Visible pour l'org.",
    makePublic: 'Rendre public',
    areaBuffer: ', +{km} km de marge',
    areaLabel: 'centré sur {center} (~{width} km de large{buffer})',
    summaryType: 'Type : {labels}',
    summaryTemplate: 'Modèle : {labels}',
    summaryArea: 'Zone : {label}',
    cardView: 'Vue en cartes',
    cards: 'Cartes',
    listView: 'Vue en liste',
    list: 'Liste',
    groupBy: 'Grouper par',
    groupNone: 'Aucun',
    groupTypeOption: 'Type',
    groupAccessOption: 'Accès',
    sortLabel: 'Trier',
    sort: {
      'updated-desc': 'Mis à jour récemment',
      'updated-asc': 'Mis à jour il y a le plus longtemps',
      'created-desc': 'Plus récents en premier',
      'created-asc': 'Plus anciens en premier',
      'title-asc': 'Nom (A–Z)',
      'title-desc': 'Nom (Z–A)',
    },
    itemCount: '{count, plural, one {# élément} other {# éléments}}',
    filteredOfTotal: '{filtered} sur {total}',
    noItemsMatch: 'Aucun élément ne correspond à vos filtres.',
    colTitle: 'Titre',
    colType: 'Type',
    colOwner: 'Propriétaire',
    colUpdated: 'Mis à jour',
    ownerYou: 'vous',
    template: {
      editor: 'Éditeur',
      viewer: 'Visionneuse',
      custom: 'Personnalisée',
    },
  },
  itemsPage: {
    eyebrow: 'Contenu',
    newItem: 'Nouvel élément',
    openMap: 'Nouvelle carte',
    addItems: 'Ajouter des éléments',
    myItems: 'Mes éléments',
    allItems: 'Tous les éléments',
    folderBreadcrumb: "Fil d'Ariane des dossiers",
    folderDetails: 'Détails du dossier →',
    emptySearchTitle: 'Aucun élément ne correspond à votre recherche',
    emptySearchDescription:
      'Rien dans {scope} ne correspond à "{query}". Essayez un autre terme ou effacez la recherche.',
    scopeYourItems: 'vos éléments',
    scopeSharedWithYou: 'les éléments partagés avec vous',
    emptyFolderTitle: '{folder} est vide',
    emptyFolderDescription:
      'Ajoutez des éléments existants, créez quelque chose de nouveau ou faites glisser des éléments ici depuis la vue de tous les éléments.',
    emptyMineTitle: "Aucun élément pour l'instant",
    emptyMineDescription:
      'Créez votre première carte, votre premier formulaire ou votre première couche de données pour commencer.',
    emptySharedTitle: "Rien n'a encore été partagé avec vous",
    emptySharedDescription:
      "Quand un collègue partage du contenu avec vous ou votre groupe, il apparaîtra ici.",
    createAnItem: 'Créer un élément',
  },
  trash: {
    restore: 'Restaurer',
    restoring: 'Restauration',
    deleteForever: 'Supprimer définitivement',
    daysLeft: '{count, plural, one {# jour restant} other {# jours restants}}',
    restoreFailed: 'Échec de la restauration : {status} {detail}',
    purgeFailed: 'Échec de la suppression : {status} {detail}',
    purgeConfirmTitle: 'Supprimer définitivement "{title}" ?',
    purgeConfirmDescription:
      "Cela supprime immédiatement l'élément et tous ses partages. Pour les couches de données, cela supprime aussi la table de données sous-jacente. Cette action est irréversible.",
  },
  dialogs: {
    confirm: 'Confirmer',
    typeToConfirmPrefix: 'Saisissez',
    typeToConfirmSuffix: 'pour confirmer :',
  },
  dependents: {
    checking: 'Vérification de ce qui dépend de ceci...',
    checkFailed:
      'Impossible de vérifier les dépendances ({error}). Procédez avec prudence.',
    loadFailed: 'Impossible de charger les dépendances.',
    referencedBy:
      '{count, plural, one {# autre élément référence ceci} other {# autres éléments référencent ceux-ci}}',
    trashHint:
      "La mise à la corbeille supprime la référence dans chacun d'eux. Vous pouvez restaurer depuis Supprimés récemment si vous changez d'avis.",
    moreNotShown: '+{count} de plus non affichés.',
  },
  accessMatrix: {
    intro:
      "Ces éléments alimentent ce composite à l'exécution. Chaque destinataire a besoin d'un accès en lecture sur chaque ligne, sinon il verra des couches cassées à l'ouverture.",
    filterPlaceholder: 'Filtrer les éléments de dépendance...',
    countsSummary:
      '{items, plural, one {# élément} other {# éléments}} · {sharees, plural, one {# destinataire} other {# destinataires}}',
    grantMissing:
      'Accorder {count, plural, one {# accès manquant} other {# accès manquants}}',
    noGaps: 'Aucune lacune',
    itemHeader: 'Élément',
    principalType: {
      user: 'utilisateur',
      group: 'groupe',
    },
    noMatches: 'Aucun élément ne correspond au filtre.',
    hasViewAccess: '{name} a un accès en lecture',
    grantViewTo: 'Accorder la lecture à {name}',
    grantView: 'Accorder la lecture',
    cannotSee: '{name} ne peut pas voir cet élément',
    grantFailed: "Échec de l'octroi",
    done: 'Terminé',
  },
  sharing: {
    sharing: 'Partage',
    dialogLabel: 'Partage de {title}',
    whoCanSee: 'Qui peut voir ceci',
    saving: 'Enregistrement',
    explicitShares: 'Partages explicites',
    noExplicitShares: 'Aucun partage individuel utilisateur ou groupe.',
    manageSharing: 'Gérer le partage',
    chipTitleShared:
      '{label} · partagé avec {count, plural, one {# destinataire} other {# destinataires}}',
    youSuffix: '{label} (vous)',
    removePrincipal: 'Retirer {label}',
    updateFailed: 'Mise à jour impossible : {status}',
    removeFailed: 'Échec du retrait : {status}',
    access: {
      private: 'Privé',
      org: 'Organisation',
      public: 'Public',
    },
    permission: {
      view: 'Lecture',
      download: 'Téléchargement',
      edit: 'Modification',
      admin: 'Administration',
    },
    expires: 'Expire',
    expired: 'Expiré',
    neverExpires: "N'expire jamais",
    setExpiry: 'Définir une expiration',
    expiryDialogLabel: 'Expiration du partage',
    days: '{count, plural, one {# jour} other {# jours}}',
    set: 'Définir',
  },
  picker: {
    noMatches: 'Aucune correspondance.',
    startTyping: 'Commencez à saisir pour rechercher.',
    unavailable: 'indisponible',
  },
  cascade: {
    title: 'Rendre aussi publics les éléments référencés ?',
    dialogLabel: 'Rendre publics les éléments référencés',
    body: "est maintenant public, mais il référence des éléments encore privés. Les visiteurs anonymes ne verront pas ces couches tant que chacune n'est pas aussi marquée publique.",
    loading: 'Chargement des éléments référencés...',
    loadFailed: 'Échec du chargement des éléments référencés',
    partialFailure:
      "{failed} des {total} éléments référencés n'ont pas pu être rendus publics. Réessayez ou corrigez les autorisations.",
    skip: 'Ignorer',
    makePublic:
      '{count, plural, one {Rendre # élément public} other {Rendre # éléments publics}}',
  },
  cascadeRevert: {
    title: 'Retirer aussi les éléments référencés du public ?',
    dialogLabel: 'Retirer les éléments référencés du public',
    body: "n'est plus public. Ces éléments référencés ne sont publics qu'à cause de celui-ci et ne sont utilisés indépendamment par aucun autre élément public ; vous pouvez donc les retirer de l'accès public en toute sécurité. Les éléments qui alimentent encore une autre carte / application publique ne sont pas affichés.",
    loadFailed: 'Échec du chargement des candidats au retrait',
    partialFailure:
      "{failed} des {total} éléments référencés n'ont pas pu être retirés. Réessayez ou corrigez les autorisations.",
    revertButton:
      'Repasser {count, plural, one {# élément} other {# éléments}} en {tier}',
  },
  reassign: {
    newOwner: 'Nouveau propriétaire',
    searchPlaceholder: 'Recherchez un utilisateur de votre organisation…',
    pickOwner: 'Choisissez le nouveau propriétaire.',
    failed: 'Échec de la réattribution',
    transferTo: 'Transférer à',
    keepAccessLegend: "Conserver l'accès de l'ancien propriétaire",
    keepView: "Lecture : l'ancien propriétaire peut encore le voir",
    keepDownload:
      "Téléchargement : l'ancien propriétaire peut aussi exporter les données brutes",
    keepEdit: "Modification : l'ancien propriétaire peut encore le modifier",
    keepAdmin:
      "Administration : l'ancien propriétaire conserve le contrôle total",
    keepNone: "Aucun : l'ancien propriétaire perd l'accès",
    reassign: 'Réattribuer',
  },
  theme: {
    label: 'Apparence',
    light: 'Clair',
    dark: 'Sombre',
    system: 'Système',
  },
  adminBackup: {
    startFailed: "La sauvegarde n'a pas pu être démarrée.",
    deleteFailed: "La sauvegarde n'a pas pu être supprimée.",
    stopFailed: "La sauvegarde n'a pas pu être arrêtée.",
    stop: 'Arrêter',
    stopping: 'Arrêt...',
    stopTitle:
      "Demander à cette sauvegarde de s'arrêter. Rien n'est publié avant la fin d'une sauvegarde, donc l'arrêter est toujours sans risque.",
    fileMissing: 'Fichier absent du serveur',
    fileMissingTitle:
      "Cette sauvegarde s'est terminée, mais son fichier n'est plus dans le dossier de sauvegarde. Il a peut-être été déplacé, supprimé à la main, ou appartient à une restauration antérieure de la base de données. Il ne peut être ni téléchargé ni restauré.",
  },
  welcome: {
    title: 'Bienvenue dans GratisGIS',
    intro: 'Votre espace de travail est vide. Choisissez un point de départ.',
    createMap: 'Créer une carte',
    createMapDesc: 'Partez d\'une carte vierge sur le fond de carte par défaut.',
    uploadData: 'Importer des données',
    uploadDataDesc: 'Importez du GeoJSON, un Shapefile ou un CSV comme couche de données.',
    loadSample: 'Charger des données d\'exemple',
    loadSampleDesc:
      'Explorez un espace de travail prêt à l\'emploi du comté de Randolph : couches, cartes, un formulaire, des applications et un relevé de terrain.',
    loading: 'Chargement des données d\'exemple...',
    loaded: '{count, plural, one {# élément d\'exemple créé} other {# éléments d\'exemple créés}}',
    allSkipped: 'Les données d\'exemple sont déjà chargées',
    failed: 'Impossible de charger les données d\'exemple',
    dismiss: 'Fermer le panneau de bienvenue',
  },
};
