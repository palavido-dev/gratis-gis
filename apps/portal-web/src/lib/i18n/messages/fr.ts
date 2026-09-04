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
    openMap: 'Ouvrir une carte',
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
