// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 Brazilian Portuguese catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: Brazilian Portuguese (not European). Casual second
 * person ("você") to match the source English's friendly tone.
 */
import type { CatalogShape } from '../locales';

export const ptBR: Partial<CatalogShape> = {
  common: {
    save: 'Salvar',
    cancel: 'Cancelar',
    delete: 'Excluir',
    close: 'Fechar',
    edit: 'Editar',
    loading: 'Carregando…',
    backToItems: 'Voltar aos itens',
    settings: 'Configurações',
    language: 'Idioma',
  },
  nav: {
    items: 'Itens',
    home: 'Início',
    admin: 'Administração',
    profile: 'Perfil',
    signOut: 'Sair',
    signIn: 'Entrar',
    overview: 'Visão geral',
    folders: 'Pastas',
    groups: 'Grupos',
    recentlyDeleted: 'Excluídos recentemente',
    users: 'Usuários',
    landingPage: 'Página inicial',
    backup: 'Backup',
    housekeeping: 'Manutenção',
    notifications: 'Notificações',
    fieldQueues: 'Filas de campo',
    migrations: 'Migrações',
    gettingStarted: 'Primeiros passos',
  },
  shell: {
    notificationsLabel: 'Notificações',
    navigation: 'Navegação',
    openNavigation: 'Abrir navegação',
    closeNavigation: 'Fechar navegação',
  },
  search: {
    placeholder: 'Pesquisar itens...',
    label: 'Pesquisar itens',
  },
  help: {
    buttonTitle: 'Ajuda (pressione ? a qualquer momento)',
    openLabel: 'Abrir ajuda',
  },
  newItem: {
    pageTitle: 'Criar um novo item',
    pageIntro:
      'Escolha o que você está criando e preencha os detalhes. Para serviços e uploads, vamos coletar o necessário na próxima tela para que o item fique pronto para uso.',
    createButton: 'Criar item',
    backButton: 'Voltar',
  },
  mapEditor: {
    legendButton: 'Legenda',
    tableButton: 'Tabela de atributos',
    markupButton: 'Anotações',
    commentsButton: 'Comentários',
    printButton: 'Imprimir este mapa',
    layerAccessButton: 'Acesso às camadas',
    saveMapButton: 'Salvar mapa',
    savedIndicator: 'Salvo',
  },
  presence: {
    youSuffix: ' (você)',
  },
  comments: {
    title: 'Comentários',
    showResolved: 'Mostrar resolvidos',
    startThread: 'Iniciar um novo tópico...',
    post: 'Publicar',
    reply: 'Responder...',
    resolve: 'Resolver',
    reopen: 'Reabrir',
    threadCount: '{count, plural, one {# tópico} other {# tópicos}}',
    noOpen:
      'Nenhum tópico aberto. Ative "Mostrar resolvidos" para ver os fechados.',
    noComments:
      'Ainda sem comentários. Inicie a conversa abaixo.',
    signInPrompt: 'Entre para comentar neste mapa.',
  },
  markup: {
    title: 'Anotações',
    add: 'Adicionar anotação',
    empty:
      'Sem anotações ainda. Adicione um conjunto e então coloque marcadores para anotar o mapa.',
    dropPin: 'Colocar marcador no centro',
    signInPrompt: 'Entre para adicionar anotações neste mapa.',
  },
  print: {
    chooserTitle: 'Imprimir este mapa',
    startSection: 'Criar um novo layout',
    startAction:
      'Criar um novo layout de impressão vinculado a este mapa',
    startHint:
      'Abre o designer de layout de impressão com este mapa já conectado aos elementos Mapa, Legenda, Escala e Seta de norte.',
    pickSection: 'Usar um layout existente',
    pickEmpty:
      'Ainda não há layouts de impressão disponíveis. Use "Criar um novo layout" acima para criar um.',
  },
  errors: {
    generic: 'Algo deu errado',
    unauthorized: 'Entre para continuar',
    notFound: 'Não encontrado',
  },
  addToFolder: {
    heading: 'Adicionar {count, plural, one {# item} other {# itens}} a uma pasta',
    searchPlaceholder: 'Pesquisar pastas',
    noMatches: 'Nenhuma pasta corresponde.',
    itemCount: '{count, plural, one {# item} other {# itens}}',
  },
  areaSearch: {
    title: 'Pesquisar por área',
    hint: 'Arraste e amplie; a lista é atualizada automaticamente.',
    close: 'Fechar pesquisa por área',
    myLocation: 'Minha localização',
    myLocationTitle: 'Centralizar o mapa na sua localização atual',
    padAreaBy: 'Ampliar a área em',
    searching: 'Pesquisando...',
    refreshNow: 'Atualizar agora',
  },
  dataPreview: {
    title: 'Pré-visualização de dados',
    eyebrow: 'Pré-visualização',
    openItem: 'Abrir item',
    closePreview: 'Fechar pré-visualização',
    layer: 'Camada',
    layerLabel: 'Camada:',
    table: 'tabela',
    tableSuffix: '(tabela)',
    noFeatures: 'Nenhuma feição nesta camada.',
    featureCount: '{count, plural, one {# feição} other {# feições}}',
    featureCountOverflow: '{count}+ de muitas feições',
    fieldCount: '{count, plural, one {# campo} other {# campos}}',
    overflowNotice:
      'Mostrando as primeiras {limit} feições. Abra o editor de mapas do item para ver a tabela de atributos completa.',
    upstreamError: 'A origem retornou um erro',
    loadFailed:
      'Não foi possível carregar a pré-visualização. Abra o item para ver os detalhes.',
  },
  filter: {
    filter: 'Filtrar',
    filterItems: 'Filtrar itens',
    activeCount:
      '{count, plural, one {# filtro ativo} other {# filtros ativos}}',
    type: 'Tipo',
    clearTypes: 'Limpar tipos',
    noItemsToFilter: 'Nenhum item para filtrar na visualização atual.',
    template: 'Modelo',
    owner: 'Proprietário',
    access: 'Acesso',
    area: 'Área',
    clearArea: 'Limpar área',
    filterByArea: 'Filtrar por área...',
    filteringByArea: 'Filtrando por área',
    clearAll: 'Limpar todos os filtros',
  },
  folders: {
    hide: 'Ocultar pastas',
  },
  folderRail: {
    newButton: '+ Nova',
    collapse: 'Recolher pasta',
    expand: 'Expandir pasta',
    folderNamePlaceholder: 'Nome da pasta',
    emptyPrefix: 'Ainda não há pastas.',
    createOne: 'Crie uma',
    emptySuffix: 'para organizar seus itens.',
    moveFailedTitle: 'Falha ao mover',
    moveFailedMessage: 'Não foi possível mover o item.',
  },
  folderMenu: {
    actionsFor: 'Ações para {folder}',
    moreActions: 'Mais ações',
    share: 'Compartilhar...',
    newSubfolder: 'Nova subpasta',
    trashTitle: 'Mover a pasta para a lixeira?',
    trashMessage:
      'Mover "{folder}" para a lixeira? O conteúdo da pasta permanece onde está; apenas a organização em pastas é removida.',
    trashMessageCascade:
      'Mover "{folder}" e as subpastas listadas para a lixeira? Os itens que não são pastas permanecem onde estão; apenas a organização em pastas é removida.',
    subfoldersAlsoTrashed:
      '{count, plural, one {# subpasta também será movida para a lixeira:} other {# subpastas também serão movidas para a lixeira:}}',
    andMore: '...e mais {count}.',
    unlinkedItems:
      '{count, plural, one {# outro item dentro perderá a referência à pasta, mas o item em si permanece.} other {# outros itens dentro perderão a referência à pasta, mas os itens em si permanecem.}}',
    multiParentNote:
      'Subpastas que também estão arquivadas em outra pasta sobreviverão a esta exclusão e não são listadas.',
    trashing: 'Movendo...',
    trashFailedTitle: 'Não foi possível mover para a lixeira',
    trashFailedMessage: 'Falha ao mover para a lixeira: {status}',
  },
  itemMenu: {
    actions: 'Ações do item',
    open: 'Abrir',
    responses: 'Respostas',
    configure: 'Configurar',
    previewData: 'Pré-visualizar dados',
    moveToFolder: 'Mover para pasta',
    removeFromFolder: 'Remover desta pasta',
    removeFromNamedFolder: 'Remover de "{folder}"',
  },
  itemForm: {
    itemType: 'Tipo de item',
    title: 'Título',
    titlePlaceholder: 'Minha camada, relatório, formulário...',
    titleRequired: 'O título é obrigatório.',
    description: 'Descrição',
    descriptionPlaceholder: 'O que é isto, e para quem é?',
    tags: 'Etiquetas',
    tagsPlaceholder: 'Separadas por vírgulas, p. ex. edifícios, lotes, campus',
    tagsHint: 'Usadas para pesquisa e filtragem.',
    thumbnail: 'Miniatura',
    visibility: 'Visibilidade',
    visibilityHintCreate:
      'Você pode alterar isso depois e adicionar compartilhamentos explícitos na página de detalhes do item.',
    visibilityHintEdit:
      'Refine com compartilhamentos por usuário ou por grupo na página de detalhes.',
    license: 'Licença',
    licenseHintPrefix:
      'Como outras pessoas podem reutilizar este item. Exibido no catálogo de dados abertos da organização',
    licenseHintSuffix: 'para itens públicos.',
    licenseCustomPlaceholder:
      'Id SPDX ou URL da licença (p. ex. https://creativecommons.org/licenses/by/4.0/)',
    recipe: 'Receita',
    pickSourceLayer:
      'Escolha uma camada de dados de origem para esta camada derivada.',
    addPipelineStep:
      'Adicione pelo menos uma etapa de ferramenta ao pipeline.',
    saveFailed: '{method} falhou: {status} {detail}',
    saveChanges: 'Salvar alterações',
    type: {
      map: {
        label: 'Mapa',
        desc: 'Um mapa base + camadas sobrepostas com estilos.',
      },
      data_layer: {
        label: 'Camada de dados',
        desc: 'Uma camada vetorial compartilhável baseada em PostGIS.',
      },
      arcgis_service: {
        label: 'Serviço ArcGIS',
        desc: 'Ponteiro ao vivo para um MapServer ou FeatureServer do ArcGIS.',
      },
      form: {
        label: 'Formulário',
        desc: 'Um formulário de coleta para trabalho de campo ou pesquisas.',
      },
      web_app: {
        label: 'Aplicativo web',
        desc: 'Um aplicativo configurável construído com widgets.',
      },
      report_template: {
        label: 'Modelo de relatório',
        desc: 'Um modelo de documento que renderiza dados.',
      },
      dashboard: {
        label: 'Painel',
        desc: 'Painéis ao vivo mostrando dados de feições.',
      },
      file: {
        label: 'Arquivo',
        desc: 'Qualquer arquivo enviado (PDF, imagem, zip, etc.).',
      },
    },
    access: {
      private: {
        label: 'Privado',
        desc: 'Somente você e as pessoas com quem compartilhar.',
      },
      org: {
        label: 'Sua organização',
        desc: 'Qualquer pessoa com uma conta na sua organização.',
      },
      public: { label: 'Público', desc: 'Qualquer pessoa na internet.' },
    },
    licenseOption: {
      notSpecified: {
        label: 'Não especificada',
        hint: 'Tratada como "direitos reservados"',
      },
      cc0: { label: 'CC0 (domínio público)', hint: 'Nenhum direito reservado' },
      ccBy: { label: 'CC BY 4.0', hint: 'Reutilização com atribuição' },
      ccBySa: {
        label: 'CC BY-SA 4.0',
        hint: 'Atribuição + compartilhamento igual',
      },
      ccByNc: { label: 'CC BY-NC 4.0', hint: 'Atribuição, não comercial' },
      oglUk: {
        label: 'Licença de Governo Aberto do Reino Unido v3',
        hint: '',
      },
      odbl: { label: 'Open Database License 1.0', hint: '' },
      mit: {
        label: 'MIT',
        hint: 'Permissiva; comum também para conjuntos de dados',
      },
      proprietary: {
        label: 'Proprietária / direitos reservados',
        hint: 'Somente uso interno',
      },
      custom: { label: 'Personalizada…', hint: 'Especifique seu próprio valor' },
    },
  },
  items: {
    share: 'Compartilhar',
    adding: 'Adicionando...',
    addToFolder: 'Adicionar a pasta',
    addToNamedFolder: 'Adicionar a {folder}',
    addToFolderFailed: 'Falha ao adicionar à pasta',
    removeFromFolderFailed: 'Falha ao remover da pasta',
    folderLoadFailed: 'Não foi possível carregar a pasta: HTTP {status}',
    moveToTrash: 'Mover para a lixeira',
    movingProgress: 'Movendo...',
    sharingProgress: 'Compartilhando...',
    searchFailed: 'A pesquisa falhou',
    reassignFailed: 'Falha ao reatribuir',
    addingItemsTo: 'Adicionando itens a:',
    addingItemsHint:
      'Marque os itens abaixo e clique em "Adicionar a {folder}".',
    selected: 'selecionados',
    selectedItem: 'Item selecionado',
    clear: 'Limpar',
    clearFilter: 'Limpar o filtro de {filter}',
    selectAll: 'Selecionar todos os itens gerenciáveis deste grupo',
    selectItem: 'Selecionar {title}',
    reassignOwner: 'Reatribuir proprietário',
    reassignHeading:
      'Reatribuir {count, plural, one {# item} other {# itens}}',
    reassignSubheading:
      'Escolha o novo proprietário; os compartilhamentos existentes de cada item são preservados.',
    bulkTrashTitle: 'Mover os itens selecionados para a lixeira',
    bulkTrashHeading:
      'Mover {count, plural, one {# item} other {# itens}} para a lixeira?',
    bulkTrashBody:
      '{count, plural, one {O item selecionado será movido para a lixeira.} other {Os itens selecionados serão movidos para a lixeira.}} Você pode restaurá-los na página "Excluídos recentemente".',
    skippedHint:
      'Itens dos quais você não é proprietário nem administrador são ignorados automaticamente.',
    bulkTrashNoneMoved:
      'Nenhum item foi movido para a lixeira. Talvez você não tenha direitos de administrador sobre os itens selecionados.',
    bulkTrashPartial:
      '{done} itens movidos para a lixeira; {skipped} ignorados (sem direitos de administrador).',
    bulkShareNoneWritten:
      'Nenhum compartilhamento foi gravado. Talvez você não tenha direitos de administrador sobre os itens selecionados.',
    bulkSharePartial:
      '{done} itens compartilhados; {skipped} ignorados (sem direitos de administrador).',
    bulkAccessNoneUpdated:
      'Nenhum item foi atualizado. Talvez você não tenha direitos de administrador sobre os itens selecionados.',
    bulkAccessPartial:
      '{done} itens atualizados; {skipped} ignorados (sem direitos de administrador).',
    shareSelectedTitle: 'Compartilhar itens selecionados',
    shareSelectedBody:
      'Cada um dos {count} itens selecionados recebe seu próprio compartilhamento para o destinatário escolhido. Itens dos quais você não é proprietário nem administrador são ignorados automaticamente.',
    shareTabPrincipal: 'Usuário ou grupo',
    shareTabOrg: 'Org.',
    shareOrgBody:
      'Qualquer pessoa conectada à sua organização poderá ver os {count} itens selecionados. Isso eleva o nível de acesso do item; os compartilhamentos de usuário / grupo existentes são mantidos.',
    sharePublicBody:
      'Qualquer pessoa na internet poderá ver os {count} itens selecionados sem fazer login. Use isto para links compartilháveis de mapas / visualizadores. Os itens referenciados pela seleção (camadas, mapas base, etc.) também precisam ser públicos; você será solicitado a aplicar em cascata ao concluir.',
    geographicScope: 'Escopo geográfico',
    noBoundaryItems: 'Ainda não há itens de limite nesta organização',
    noScope: 'Sem escopo (irrestrito)',
    geoScopeHint:
      'Quando definido, quem acessa estes itens via {via} vê apenas as feições dentro do limite. Aplicado na camada da API.',
    geoScopeViaOrg: 'sua organização',
    geoScopeViaPublic: 'acesso público',
    recipient: 'Destinatário',
    groupTag: 'grupo',
    searchUserOrGroup: 'Pesquise um usuário ou grupo',
    noMatchingUsersOrGroups: 'Nenhum usuário ou grupo correspondente.',
    startTypingName: 'Comece a digitar um nome para pesquisar.',
    permission: 'Permissão',
    permissionDesc: {
      view: 'Ver o item',
      download: 'Ver + exportar dados em massa',
      edit: 'Ver + alterar conteúdo',
      admin: 'Controle total, incluindo compartilhamento',
    },
    makeOrgVisible: 'Visível para a org.',
    makePublic: 'Tornar público',
    areaBuffer: ', +{km} km de margem',
    areaLabel: 'centrado em {center} (~{width} km de largura{buffer})',
    summaryType: 'Tipo: {labels}',
    summaryTemplate: 'Modelo: {labels}',
    summaryArea: 'Área: {label}',
    cardView: 'Visualização em cartões',
    cards: 'Cartões',
    listView: 'Visualização em lista',
    list: 'Lista',
    groupBy: 'Agrupar por',
    groupNone: 'Nenhum',
    groupTypeOption: 'Tipo',
    groupAccessOption: 'Acesso',
    sortLabel: 'Ordenar',
    sort: {
      'updated-desc': 'Atualizados recentemente',
      'updated-asc': 'Atualizados há mais tempo',
      'created-desc': 'Mais novos primeiro',
      'created-asc': 'Mais antigos primeiro',
      'title-asc': 'Nome (A–Z)',
      'title-desc': 'Nome (Z–A)',
    },
    itemCount: '{count, plural, one {# item} other {# itens}}',
    filteredOfTotal: '{filtered} de {total}',
    noItemsMatch: 'Nenhum item corresponde aos seus filtros.',
    colTitle: 'Título',
    colType: 'Tipo',
    colOwner: 'Proprietário',
    colUpdated: 'Atualizado',
    ownerYou: 'você',
    template: {
      editor: 'Editor',
      viewer: 'Visualizador',
      custom: 'Personalizado',
    },
  },
  itemsPage: {
    eyebrow: 'Conteúdo',
    newItem: 'Novo item',
    addItems: 'Adicionar itens',
    myItems: 'Meus itens',
    allItems: 'Todos os itens',
    folderBreadcrumb: 'Trilha de pastas',
    folderDetails: 'Detalhes da pasta →',
    emptySearchTitle: 'Nenhum item corresponde à sua pesquisa',
    emptySearchDescription:
      'Nada em {scope} corresponde a "{query}". Tente outro termo ou limpe a pesquisa.',
    scopeYourItems: 'seus itens',
    scopeSharedWithYou: 'os itens compartilhados com você',
    emptyFolderTitle: '{folder} está vazia',
    emptyFolderDescription:
      'Adicione itens existentes, crie algo novo ou arraste itens para cá a partir da visualização de todos os itens.',
    emptyMineTitle: 'Ainda não há itens',
    emptyMineDescription:
      'Crie seu primeiro mapa, formulário ou camada de dados para começar.',
    emptySharedTitle: 'Nada foi compartilhado com você ainda',
    emptySharedDescription:
      'Quando um colega compartilhar conteúdo com você ou seu grupo, ele aparecerá aqui.',
    createAnItem: 'Criar um item',
  },
  trash: {
    restore: 'Restaurar',
    restoring: 'Restaurando',
    deleteForever: 'Excluir para sempre',
    daysLeft: '{count, plural, one {resta # dia} other {restam # dias}}',
    restoreFailed: 'Falha ao restaurar: {status} {detail}',
    purgeFailed: 'Falha ao excluir: {status} {detail}',
    purgeConfirmTitle: 'Excluir permanentemente "{title}"?',
    purgeConfirmDescription:
      'Isto remove imediatamente o item e todos os compartilhamentos associados. Para camadas de dados, a tabela de dados subjacente também é removida. Não é possível desfazer.',
  },
  dialogs: {
    confirm: 'Confirmar',
    typeToConfirmPrefix: 'Digite',
    typeToConfirmSuffix: 'para confirmar:',
  },
  dependents: {
    checking: 'Verificando o que depende disto...',
    checkFailed:
      'Não foi possível verificar os dependentes ({error}). Prossiga com cautela.',
    loadFailed: 'Não foi possível carregar os dependentes.',
    referencedBy:
      '{count, plural, one {# outro item faz referência a isto} other {# outros itens fazem referência a estes}}',
    trashHint:
      'Mover para a lixeira remove a referência de cada um deles. Você pode restaurar em Excluídos recentemente se mudar de ideia.',
    moreNotShown: '+{count} a mais não exibidos.',
  },
  accessMatrix: {
    intro:
      'Estes itens alimentam este composto em tempo de execução. Cada destinatário precisa de acesso de visualização em cada linha, ou verá camadas quebradas ao abri-lo.',
    filterPlaceholder: 'Filtrar itens de dependência...',
    countsSummary:
      '{items, plural, one {# item} other {# itens}} · {sharees, plural, one {# destinatário} other {# destinatários}}',
    grantMissing:
      'Conceder {count, plural, one {# acesso faltante} other {# acessos faltantes}}',
    noGaps: 'Sem lacunas',
    itemHeader: 'Item',
    principalType: {
      user: 'usuário',
      group: 'grupo',
    },
    noMatches: 'Nenhum item corresponde ao filtro.',
    hasViewAccess: '{name} tem acesso de visualização',
    grantViewTo: 'Conceder visualização a {name}',
    grantView: 'Conceder visualização',
    cannotSee: '{name} não pode ver este item',
    grantFailed: 'Falha ao conceder',
    done: 'Concluído',
  },
  sharing: {
    sharing: 'Compartilhamento',
    dialogLabel: 'Compartilhamento de {title}',
    whoCanSee: 'Quem pode ver isto',
    saving: 'Salvando',
    explicitShares: 'Compartilhamentos explícitos',
    noExplicitShares:
      'Nenhum compartilhamento individual de usuário ou grupo.',
    manageSharing: 'Gerenciar compartilhamento',
    chipTitleShared:
      '{label} · compartilhado com {count, plural, one {# destinatário} other {# destinatários}}',
    youSuffix: '{label} (você)',
    removePrincipal: 'Remover {label}',
    updateFailed: 'Não foi possível atualizar: {status}',
    removeFailed: 'Falha ao remover: {status}',
    access: {
      private: 'Privado',
      org: 'Organização',
      public: 'Público',
    },
    permission: {
      view: 'Ver',
      download: 'Baixar',
      edit: 'Editar',
      admin: 'Administrar',
    },
    expires: 'Expira',
    expired: 'Expirado',
    neverExpires: 'Nunca expira',
    setExpiry: 'Definir expiração',
    expiryDialogLabel: 'Expiração do compartilhamento',
    days: '{count, plural, one {# dia} other {# dias}}',
    set: 'Definir',
  },
  picker: {
    noMatches: 'Sem correspondências.',
    startTyping: 'Comece a digitar para pesquisar.',
    unavailable: 'indisponível',
  },
  cascade: {
    title: 'Tornar públicos também os itens referenciados?',
    dialogLabel: 'Tornar públicos os itens referenciados',
    body: 'agora é público, mas faz referência a itens que ainda são privados. Visitantes anônimos não verão essas camadas até que cada uma também seja marcada como pública.',
    loading: 'Carregando itens referenciados...',
    loadFailed: 'Falha ao carregar os itens referenciados',
    partialFailure:
      '{failed} de {total} itens referenciados não puderam ser tornados públicos. Tente novamente ou corrija as permissões.',
    skip: 'Pular',
    makePublic:
      '{count, plural, one {Tornar # item público} other {Tornar # itens públicos}}',
  },
  cascadeRevert: {
    title: 'Reverter também os itens referenciados do acesso público?',
    dialogLabel: 'Reverter os itens referenciados do acesso público',
    body: 'não é mais público. Estes itens referenciados são públicos apenas por causa deste e não são usados de forma independente por nenhum outro item público; portanto, você pode retirá-los do acesso público com segurança. Itens que ainda alimentam outro mapa / aplicativo público não são exibidos.',
    loadFailed: 'Falha ao carregar os candidatos à reversão',
    partialFailure:
      '{failed} de {total} itens referenciados não puderam ser revertidos. Tente novamente ou corrija as permissões.',
    revertButton:
      'Reverter {count, plural, one {# item} other {# itens}} para {tier}',
  },
  reassign: {
    newOwner: 'Novo proprietário',
    searchPlaceholder: 'Pesquise um usuário da sua organização…',
    pickOwner: 'Escolha o novo proprietário.',
    failed: 'Falha ao reatribuir',
    transferTo: 'Transferir para',
    keepAccessLegend: 'Manter o acesso do proprietário anterior',
    keepView: 'Ver: o proprietário anterior ainda pode vê-lo',
    keepDownload:
      'Baixar: o proprietário anterior também pode exportar dados brutos',
    keepEdit: 'Editar: o proprietário anterior ainda pode alterá-lo',
    keepAdmin:
      'Administrar: o proprietário anterior mantém o controle total',
    keepNone: 'Nenhum: o proprietário anterior perde o acesso',
    reassign: 'Reatribuir',
  },
  theme: {
    label: 'Aparência',
    light: 'Claro',
    dark: 'Escuro',
    system: 'Sistema',
  },
  welcome: {
    title: 'Bem-vindo ao GratisGIS',
    intro: 'Seu espaço de trabalho está vazio. Escolha por onde começar.',
    createMap: 'Criar um mapa',
    createMapDesc: 'Comece com um mapa em branco sobre o mapa base padrão.',
    uploadData: 'Enviar dados',
    uploadDataDesc: 'Importe GeoJSON, Shapefile ou CSV como uma camada de dados.',
    loadSample: 'Carregar dados de exemplo',
    loadSampleDesc:
      'Explore um espaço de trabalho pronto do condado de Randolph: camadas, mapas, um formulário, aplicativos e um levantamento de campo.',
    loading: 'Carregando dados de exemplo...',
    loaded: '{count, plural, one {# item de exemplo criado} other {# itens de exemplo criados}}',
    allSkipped: 'Os dados de exemplo já estão carregados',
    failed: 'Não foi possível carregar os dados de exemplo',
    dismiss: 'Dispensar o painel de boas-vindas',
  },
};
