// LSDateFormat month, weekday and era names of every ACF 2023 setLocale name, from the Java 17.0.21 locale each name
// selects (format-context DateFormatSymbols; short eras from Calendar.getDisplayName), verified on ACF 2023.0.26;
// generated data.

/** Names a named LSDateFormat style prints: months January first, weekdays Sunday first, eras BC then AD. */
export interface AcfDateNames {
  readonly months: readonly string[];
  readonly shortMonths: readonly string[];
  readonly weekdays: readonly string[];
  readonly shortWeekdays: readonly string[];
  /** What G to GGG print. */
  readonly eras: readonly string[];
  /** What GGGG prints. */
  readonly longEras: readonly string[];
}

/** getMonths(), '|'-separated. */
const MONTHS: readonly string[] = [
  'January|February|March|April|May|June|July|August|September|October|November|December',
  '一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月',
  '1月|2月|3月|4月|5月|6月|7月|8月|9月|10月|11月|12月',
  'januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december',
  'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre',
  'Jänner|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember',
  'Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember',
  'gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre',
  '1월|2월|3월|4월|5월|6월|7월|8월|9월|10월|11월|12월',
  'januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember',
  'janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro',
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre',
  'januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december',
  'Januarie|Februarie|Maart|April|Mei|Junie|Julie|Augustus|September|Oktober|November|Desember',
  'ndzɔ̀ŋɔ̀nùm|ndzɔ̀ŋɔ̀kƗ̀zùʔ|ndzɔ̀ŋɔ̀tƗ̀dʉ̀ghà|ndzɔ̀ŋɔ̀tǎafʉ̄ghā|ndzɔ̀ŋèsèe|ndzɔ̀ŋɔ̀nzùghò|ndzɔ̀ŋɔ̀dùmlo|ndzɔ̀ŋɔ̀kwîfɔ̀e|ndzɔ̀ŋɔ̀tƗ̀fʉ̀ghàdzughù|ndzɔ̀ŋɔ̀ghǔuwelɔ̀m|ndzɔ̀ŋɔ̀chwaʔàkaa wo|ndzɔ̀ŋèfwòo',
  'Sanda-Ɔpɛpɔn|Kwakwar-Ɔgyefuo|Ebɔw-Ɔbenem|Ebɔbira-Oforisuo|Esusow Aketseaba-Kɔtɔnimba|Obirade-Ayɛwohomumu|Ayɛwoho-Kitawonsa|Difuu-Ɔsandaa|Fankwa-Ɛbɔ|Ɔbɛsɛ-Ahinime|Ɔberɛfɛw-Obubuo|Mumu-Ɔpɛnimba',
  'ጃንዩወሪ|ፌብሩወሪ|ማርች|ኤፕሪል|ሜይ|ጁን|ጁላይ|ኦገስት|ሴፕቴምበር|ኦክቶበር|ኖቬምበር|ዲሴምበር',
  'يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر',
  'جانفي|فيفري|مارس|أفريل|ماي|جوان|جويلية|أوت|سبتمبر|أكتوبر|نوفمبر|ديسمبر',
  'كانون الثاني|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين الأول|تشرين الثاني|كانون الأول',
  'يناير|فبراير|مارس|أبريل|ماي|يونيو|يوليوز|غشت|شتنبر|أكتوبر|نونبر|دجنبر',
  'يناير|فبراير|مارس|إبريل|مايو|يونيو|يوليو|أغشت|شتمبر|أكتوبر|نوفمبر|دجمبر',
  'জানুৱাৰী|ফেব্ৰুৱাৰী|মাৰ্চ|এপ্ৰিল|মে’|জুন|জুলাই|আগষ্ট|ছেপ্তেম্বৰ|অক্টোবৰ|নৱেম্বৰ|ডিচেম্বৰ',
  'Januari|Februari|Machi|Aprili|Mei|Juni|Julai|Agosti|Septemba|Oktoba|Novemba|Desemba',
  'de xineru|de febreru|de marzu|d’abril|de mayu|de xunu|de xunetu|d’agostu|de setiembre|d’ochobre|de payares|d’avientu',
  'yanvar|fevral|mart|aprel|may|iyun|iyul|avqust|sentyabr|oktyabr|noyabr|dekabr',
  'Kɔndɔŋ|Màcɛ̂l|Màtùmb|Màtop|M̀puyɛ|Hìlòndɛ̀|Njèbà|Hìkaŋ|Dìpɔ̀s|Bìòôm|Màyɛsèp|Lìbuy li ńyèe',
  'студзеня|лютага|сакавіка|красавіка|мая|чэрвеня|ліпеня|жніўня|верасня|кастрычніка|лістапада|снежня',
  'Januari|Februari|Machi|Epreo|Mei|Juni|Julai|Ogasti|Septemba|Oktoba|Novemba|Disemba',
  'pa mwedzi gwa hutala|pa mwedzi gwa wuvili|pa mwedzi gwa wudatu|pa mwedzi gwa wutai|pa mwedzi gwa wuhanu|pa mwedzi gwa sita|pa mwedzi gwa saba|pa mwedzi gwa nane|pa mwedzi gwa tisa|pa mwedzi gwa kumi|pa mwedzi gwa kumi na moja|pa mwedzi gwa kumi na mbili',
  'януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември',
  'zanwuye|feburuye|marisi|awirili|mɛ|zuwɛn|zuluye|uti|sɛtanburu|ɔkutɔburu|nowanburu|desanburu',
  'জানুয়ারী|ফেব্রুয়ারী|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর',
  'ཟླ་བ་དང་པོ|ཟླ་བ་གཉིས་པ|ཟླ་བ་གསུམ་པ|ཟླ་བ་བཞི་པ|ཟླ་བ་ལྔ་པ|ཟླ་བ་དྲུག་པ|ཟླ་བ་བདུན་པ|ཟླ་བ་བརྒྱད་པ|ཟླ་བ་དགུ་པ|ཟླ་བ་བཅུ་པ|ཟླ་བ་བཅུ་གཅིག་པ|ཟླ་བ་བཅུ་གཉིས་པ',
  'Genver|Cʼhwevrer|Meurzh|Ebrel|Mae|Mezheven|Gouere|Eost|Gwengolo|Here|Du|Kerzu',
  'जानुवारी|फेब्रुवारी|मार्स|एफ्रिल|मे|जुन|जुलाइ|आगस्थ|सेबथेज्ब़र|अखथबर|नबेज्ब़र|दिसेज्ब़र',
  'januar|februar|mart|april|maj|juni|juli|august|septembar|oktobar|novembar|decembar',
  'de gener|de febrer|de març|d’abril|de maig|de juny|de juliol|d’agost|de setembre|d’octubre|de novembre|de desembre',
  '𑄎𑄚𑄪𑄠𑄢𑄨|𑄜𑄬𑄛𑄴𑄝𑄳𑄢𑄪𑄠𑄢𑄨|𑄟𑄢𑄴𑄌𑄧|𑄃𑄬𑄛𑄳𑄢𑄨𑄣𑄴|𑄟𑄬|𑄎𑄪𑄚𑄴|𑄎𑄪𑄣𑄭|𑄃𑄉𑄧𑄌𑄴𑄑𑄴|𑄥𑄬𑄛𑄴𑄑𑄬𑄟𑄴𑄝𑄧𑄢𑄴|𑄃𑄧𑄇𑄴𑄑𑄬𑄝𑄧𑄢𑄴|𑄚𑄧𑄞𑄬𑄟𑄴𑄝𑄧𑄢𑄴|𑄓𑄨𑄥𑄬𑄟𑄴𑄝𑄧𑄢𑄴',
  'январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь',
  'Enero|Pebrero|Marso|Abril|Mayo|Hunyo|Hulyo|Agosto|Setyembre|Oktubre|Nobyembre|Disyembre',
  'Okwokubanza|Okwakabiri|Okwakashatu|Okwakana|Okwakataana|Okwamukaaga|Okwamushanju|Okwamunaana|Okwamwenda|Okwaikumi|Okwaikumi na kumwe|Okwaikumi na ibiri',
  'ᎤᏃᎸᏔᏅ|ᎧᎦᎵ|ᎠᏅᏱ|ᎧᏬᏂ|ᎠᏂᏍᎬᏘ|ᏕᎭᎷᏱ|ᎫᏰᏉᏂ|ᎦᎶᏂ|ᏚᎵᏍᏗ|ᏚᏂᏅᏗ|ᏅᏓᏕᏆ|ᎥᏍᎩᏱ',
  'کانوونی دووەم|شوبات|ئازار|نیسان|ئایار|حوزەیران|تەمووز|ئاب|ئەیلوول|تشرینی یەکەم|تشرینی دووەم|کانونی یەکەم',
  'ledna|února|března|dubna|května|června|července|srpna|září|října|listopadu|prosince',
  'Ionawr|Chwefror|Mawrth|Ebrill|Mai|Mehefin|Gorffennaf|Awst|Medi|Hydref|Tachwedd|Rhagfyr',
  'januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december',
  'Mori ghwa imbiri|Mori ghwa kawi|Mori ghwa kadadu|Mori ghwa kana|Mori ghwa kasanu|Mori ghwa karandadu|Mori ghwa mfungade|Mori ghwa wunyanya|Mori ghwa ikenda|Mori ghwa ikumi|Mori ghwa ikumi na imweri|Mori ghwa ikumi na iwi',
  'Žanwiye|Feewiriye|Marsi|Awiril|Me|Žuweŋ|Žuyye|Ut|Sektanbur|Oktoobur|Noowanbur|Deesanbur',
  'जनवरी|फरवरी|मार्च|अप्रैल|मेई|जून|जुलाई|अगस्त|सितंबर|अत्तूबर|नवंबर|दिसंबर',
  'januara|februara|měrca|apryla|maja|junija|julija|awgusta|septembra|oktobra|nowembra|decembra',
  'dimɔ́di|ŋgɔndɛ|sɔŋɛ|diɓáɓá|emiasele|esɔpɛsɔpɛ|madiɓɛ́díɓɛ́|diŋgindi|nyɛtɛki|mayésɛ́|tiníní|eláŋgɛ́',
  'Sanvie|Fébirie|Mars|Aburil|Mee|Sueŋ|Súuyee|Ut|Settembar|Oktobar|Novembar|Disambar',
  'ཟླ་དངཔ་|ཟླ་གཉིས་པ་|ཟླ་གསུམ་པ་|ཟླ་བཞི་པ་|ཟླ་ལྔ་པ་|ཟླ་དྲུག་པ|ཟླ་བདུན་པ་|ཟླ་བརྒྱད་པ་|ཟླ་དགུ་པ་|ཟླ་བཅུ་པ་|ཟླ་བཅུ་གཅིག་པ་|ཟླ་བཅུ་གཉིས་པ་',
  'Mweri wa mbere|Mweri wa kaĩri|Mweri wa kathatũ|Mweri wa kana|Mweri wa gatano|Mweri wa gatantatũ|Mweri wa mũgwanja|Mweri wa kanana|Mweri wa kenda|Mweri wa ikũmi|Mweri wa ikũmi na ũmwe|Mweri wa ikũmi na Kaĩrĩ',
  'dzove|dzodze|tedoxe|afɔfĩe|dama|masa|siamlɔm|deasiamime|anyɔnyɔ|kele|adeɛmekpɔxe|dzome',
  'Ιανουαρίου|Φεβρουαρίου|Μαρτίου|Απριλίου|Μαΐου|Ιουνίου|Ιουλίου|Αυγούστου|Σεπτεμβρίου|Οκτωβρίου|Νοεμβρίου|Δεκεμβρίου',
  'januaro|februaro|marto|aprilo|majo|junio|julio|aŭgusto|septembro|oktobro|novembro|decembro',
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|octubre|noviembre|diciembre',
  'jaanuar|veebruar|märts|aprill|mai|juuni|juuli|august|september|oktoober|november|detsember',
  'urtarrilak|otsailak|martxoak|apirilak|maiatzak|ekainak|uztailak|abuztuak|irailak|urriak|azaroak|abenduak',
  'ngɔn osú|ngɔn bɛ̌|ngɔn lála|ngɔn nyina|ngɔn tána|ngɔn saməna|ngɔn zamgbála|ngɔn mwom|ngɔn ebulú|ngɔn awóm|ngɔn awóm ai dziá|ngɔn awóm ai bɛ̌',
  'ژانویهٔ|فوریهٔ|مارس|آوریل|مهٔ|ژوئن|ژوئیهٔ|اوت|سپتامبر|اکتبر|نوامبر|دسامبر',
  'جنوری|فبروری|مارچ|اپریل|می|جون|جولای|اگست|سپتمبر|اکتوبر|نومبر|دسمبر',
  'siilo|colte|mbooy|seeɗto|duujal|korse|morso|juko|siilto|yarkomaa|jolal|bowte',
  'tammikuuta|helmikuuta|maaliskuuta|huhtikuuta|toukokuuta|kesäkuuta|heinäkuuta|elokuuta|syyskuuta|lokakuuta|marraskuuta|joulukuuta',
  'januar|februar|mars|apríl|mai|juni|juli|august|september|oktober|november|desember',
  'Zenâr|Fevrâr|Març|Avrîl|Mai|Jugn|Lui|Avost|Setembar|Otubar|Novembar|Dicembar',
  'Jannewaris|Febrewaris|Maart|April|Maaie|Juny|July|Augustus|Septimber|Oktober|Novimber|Desimber',
  'Eanáir|Feabhra|Márta|Aibreán|Bealtaine|Meitheamh|Iúil|Lúnasa|Meán Fómhair|Deireadh Fómhair|Samhain|Nollaig',
  'dhen Fhaoilleach|dhen Ghearran|dhen Mhàrt|dhen Ghiblean|dhen Chèitean|dhen Ògmhios|dhen Iuchar|dhen Lùnastal|dhen t-Sultain|dhen Dàmhair|dhen t-Samhain|dhen Dùbhlachd',
  'xaneiro|febreiro|marzo|abril|maio|xuño|xullo|agosto|setembro|outubro|novembro|decembro',
  'Januar|Februar|März|April|Mai|Juni|Juli|Auguscht|Septämber|Oktoober|Novämber|Dezämber',
  'જાન્યુઆરી|ફેબ્રુઆરી|માર્ચ|એપ્રિલ|મે|જૂન|જુલાઈ|ઑગસ્ટ|સપ્ટેમ્બર|ઑક્ટોબર|નવેમ્બર|ડિસેમ્બર',
  'Chanuari|Feburari|Machi|Apiriri|Mei|Juni|Chulai|Agosti|Septemba|Okitoba|Nobemba|Disemba',
  'Jerrey-geuree|Toshiaght-arree|Mayrnt|Averil|Boaldyn|Mean-souree|Jerrey-souree|Luanistyn|Mean-fouyir|Jerrey-fouyir|Mee Houney|Mee ny Nollick',
  'Janairu|Faburairu|Maris|Afirilu|Mayu|Yuni|Yuli|Agusta|Satumba|Oktoba|Nuwamba|Disamba',
  'Ianuali|Pepeluali|Malaki|ʻApelila|Mei|Iune|Iulai|ʻAukake|Kepakemapa|ʻOkakopa|Nowemapa|Kekemapa',
  'ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר',
  'जनवरी|फ़रवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्तूबर|नवंबर|दिसंबर',
  'siječnja|veljače|ožujka|travnja|svibnja|lipnja|srpnja|kolovoza|rujna|listopada|studenoga|prosinca',
  'januara|februara|měrca|apryla|meje|junija|julija|awgusta|septembra|oktobra|nowembra|decembra',
  'január|február|március|április|május|június|július|augusztus|szeptember|október|november|december',
  'հունվարի|փետրվարի|մարտի|ապրիլի|մայիսի|հունիսի|հուլիսի|օգոստոսի|սեպտեմբերի|հոկտեմբերի|նոյեմբերի|դեկտեմբերի',
  'januario|februario|martio|april|maio|junio|julio|augusto|septembre|octobre|novembre|decembre',
  'Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember',
  'Jenụwarị|Febrụwarị|Maachị|Epreel|Mee|Juun|Julaị|Ọgọọst|Septemba|Ọktoba|Novemba|Disemba',
  'ꋍꆪ|ꑍꆪ|ꌕꆪ|ꇖꆪ|ꉬꆪ|ꃘꆪ|ꏃꆪ|ꉆꆪ|ꈬꆪ|ꊰꆪ|ꊰꊪꆪ|ꊰꑋꆪ',
  'janúar|febrúar|mars|apríl|maí|júní|júlí|ágúst|september|október|nóvember|desember',
  'Nduŋmbi Saŋ|Pɛsaŋ Pɛ́pá|Pɛsaŋ Pɛ́tát|Pɛsaŋ Pɛ́nɛ́kwa|Pɛsaŋ Pataa|Pɛsaŋ Pɛ́nɛ́ntúkú|Pɛsaŋ Saambá|Pɛsaŋ Pɛ́nɛ́fɔm|Pɛsaŋ Pɛ́nɛ́pfúꞋú|Pɛsaŋ Nɛgɛ́m|Pɛsaŋ Ntsɔ̌pmɔ́|Pɛsaŋ Ntsɔ̌ppá',
  'Januari|Februari|Machi|Aprilyi|Mei|Junyi|Julyai|Agusti|Septemba|Oktoba|Novemba|Desemba',
  'იანვარი|თებერვალი|მარტი|აპრილი|მაისი|ივნისი|ივლისი|აგვისტო|სექტემბერი|ოქტომბერი|ნოემბერი|დეკემბერი',
  'Yennayer|Fuṛar|Meɣres|Yebrir|Mayyu|Yunyu|Yulyu|Ɣuct|Ctembeṛ|Tubeṛ|Nunembeṛ|Duǧembeṛ',
  'Mwai wa mbee|Mwai wa kelĩ|Mwai wa katatũ|Mwai wa kana|Mwai wa katano|Mwai wa thanthatũ|Mwai wa muonza|Mwai wa nyaanya|Mwai wa kenda|Mwai wa ĩkumi|Mwai wa ĩkumi na ĩmwe|Mwai wa ĩkumi na ilĩ',
  'Mwedi Ntandi|Mwedi wa Pili|Mwedi wa Tatu|Mwedi wa Nchechi|Mwedi wa Nnyano|Mwedi wa Nnyano na Umo|Mwedi wa Nnyano na Mivili|Mwedi wa Nnyano na Mitatu|Mwedi wa Nnyano na Nchechi|Mwedi wa Nnyano na Nnyano|Mwedi wa Nnyano na Nnyano na U|Mwedi wa Nnyano na Nnyano na M',
  'Janeru|Febreru|Marsu|Abril|Maiu|Junhu|Julhu|Agostu|Setenbru|Otubru|Nuvenbru|Dizenbru',
  'Njenuarĩ|Mwere wa kerĩ|Mwere wa gatatũ|Mwere wa kana|Mwere wa gatano|Mwere wa gatandatũ|Mwere wa mũgwanja|Mwere wa kanana|Mwere wa kenda|Mwere wa ikũmi|Mwere wa ikũmi na ũmwe|Ndithemba',
  'қаңтар|ақпан|наурыз|сәуір|мамыр|маусым|шілде|тамыз|қыркүйек|қазан|қараша|желтоқсан',
  'pamba|wanja|mbiyɔ mɛndoŋgɔ|Nyɔlɔmbɔŋgɔ|Mɔnɔ ŋgbanja|Nyaŋgwɛ ŋgbanja|kuŋgwɛ|fɛ|njapi|nyukul|M11|ɓulɓusɛ',
  'januaarip|februaarip|marsip|apriilip|maajip|juunip|juulip|aggustip|septembarip|oktobarip|novembarip|decembarip',
  'Mulgul|Ng’atyaato|Kiptaamo|Iwootkuut|Mamuut|Paagi|Ng’eiyeet|Rooptui|Bureet|Epeeso|Kipsuunde ne taai|Kipsuunde nebo aeng’',
  'មករា|កុម្ភៈ|មីនា|មេសា|ឧសភា|មិថុនា|កក្កដា|សីហា|កញ្ញា|តុលា|វិច្ឆិកា|ធ្នូ',
  'ಜನವರಿ|ಫೆಬ್ರವರಿ|ಮಾರ್ಚ್|ಏಪ್ರಿಲ್|ಮೇ|ಜೂನ್|ಜುಲೈ|ಆಗಸ್ಟ್|ಸೆಪ್ಟೆಂಬರ್|ಅಕ್ಟೋಬರ್|ನವೆಂಬರ್|ಡಿಸೆಂಬರ್',
  'जानेवारी|फेब्रुवारी|मार्च|एप्रील|मे|जून|जुलय|ऑगस्ट|सप्टेंबर|ऑक्टोबर|नोव्हेंबर|डिसेंबर',
  'جنؤری|فرؤری|مارٕچ|اپریل|میٔ|جوٗن|جوٗلایی|اگست|ستمبر|اکتوٗبر|نومبر|دسمبر',
  'Januali|Febluali|Machi|Aplili|Mei|Juni|Julai|Agosti|Septemba|Oktoba|Novemba|Desemba',
  'ŋwíí a ntɔ́ntɔ|ŋwíí akǝ bɛ́ɛ|ŋwíí akǝ ráá|ŋwíí akǝ nin|ŋwíí akǝ táan|ŋwíí akǝ táafɔk|ŋwíí akǝ táabɛɛ|ŋwíí akǝ táaraa|ŋwíí akǝ táanin|ŋwíí akǝ ntɛk|ŋwíí akǝ ntɛk di bɔ́k|ŋwíí akǝ ntɛk di bɛ́ɛ',
  'Jannewa|Fäbrowa|Määz|Aprell|Mai|Juuni|Juuli|Oujoß|Septämber|Oktohber|Novämber|Dezämber',
  'rêbendanê|reşemiyê|adarê|avrêlê|gulanê|pûşperê|tîrmehê|gelawêjê|rezberê|kewçêrê|sermawezê|berfanbarê',
  'mis Genver|mis Hwevrer|mis Meurth|mis Ebrel|mis Me|mis Metheven|mis Gortheren|mis Est|mis Gwynngala|mis Hedra|mis Du|mis Kevardhu',
  'Kʉfúngatɨ|Kʉnaanɨ|Kʉkeenda|Kwiikumi|Kwiinyambála|Kwiidwaata|Kʉmʉʉnchɨ|Kʉvɨɨrɨ|Kʉsaatʉ|Kwiinyi|Kʉsaano|Kʉsasatʉ',
  'Januar|Februar|Mäerz|Abrëll|Mee|Juni|Juli|August|September|Oktober|November|Dezember',
  'Janwaliyo|Febwaliyo|Marisi|Apuli|Maayi|Juuni|Julaayi|Agusito|Sebuttemba|Okitobba|Novemba|Desemba',
  'Wiótheȟika Wí|Thiyóȟeyuŋka Wí|Ištáwičhayazaŋ Wí|Pȟežítȟo Wí|Čhaŋwápetȟo Wí|Wípazukȟa-wašté Wí|Čhaŋpȟásapa Wí|Wasútȟuŋ Wí|Čhaŋwápeǧi Wí|Čhaŋwápe-kasná Wí|Waníyetu Wí|Tȟahékapšuŋ Wí',
  'sánzá ya yambo|sánzá ya míbalé|sánzá ya mísáto|sánzá ya mínei|sánzá ya mítáno|sánzá ya motóbá|sánzá ya nsambo|sánzá ya mwambe|sánzá ya libwa|sánzá ya zómi|sánzá ya zómi na mɔ̌kɔ́|sánzá ya zómi na míbalé',
  'ມັງກອນ|ກຸມພາ|ມີນາ|ເມສາ|ພຶດສະພາ|ມິຖຸນາ|ກໍລະກົດ|ສິງຫາ|ກັນຍາ|ຕຸລາ|ພະຈິກ|ທັນວາ',
  'جانڤیە|فئڤریە|مارس|آڤریل|مئی|جوٙأن|جوٙلا|آگوست|سئپتامر|ئوکتوڤر|نوڤامر|دئسامر',
  'sausio|vasario|kovo|balandžio|gegužės|birželio|liepos|rugpjūčio|rugsėjo|spalio|lapkričio|gruodžio',
  'Ciongo|Lùishi|Lusòlo|Mùuyà|Lumùngùlù|Lufuimi|Kabàlàshìpù|Lùshìkà|Lutongolo|Lungùdi|Kaswèkèsè|Ciswà',
  'Dwe mar Achiel|Dwe mar Ariyo|Dwe mar Adek|Dwe mar Ang’wen|Dwe mar Abich|Dwe mar Auchiel|Dwe mar Abiriyo|Dwe mar Aboro|Dwe mar Ochiko|Dwe mar Apar|Dwe mar gi achiel|Dwe mar Apar gi ariyo',
  'janvāris|februāris|marts|aprīlis|maijs|jūnijs|jūlijs|augusts|septembris|oktobris|novembris|decembris',
  'Oladalʉ́|Arát|Ɔɛnɨ́ɔɨŋɔk|Olodoyíóríê inkókúâ|Oloilépūnyīē inkókúâ|Kújúɔrɔk|Mórusásin|Ɔlɔ́ɨ́bɔ́rárɛ|Kúshîn|Olgísan|Pʉshʉ́ka|Ntʉ́ŋʉ́s',
  'Januarĩ|Feburuarĩ|Machi|Ĩpurũ|Mĩĩ|Njuni|Njuraĩ|Agasti|Septemba|Oktũba|Novemba|Dicemba',
  'zanvie|fevriye|mars|avril|me|zin|zilye|out|septam|oktob|novam|desam',
  'Janoary|Febroary|Martsa|Aprily|Mey|Jona|Jolay|Aogositra|Septambra|Oktobra|Novambra|Desambra',
  'Mweri wo kwanza|Mweri wo unayeli|Mweri wo uneraru|Mweri wo unecheshe|Mweri wo unethanu|Mweri wo thanu na mocha|Mweri wo saba|Mweri wo nane|Mweri wo tisa|Mweri wo kumi|Mweri wo kumi na moja|Mweri wo kumi na yel’li',
  'iməg mbegtug|imeg àbùbì|imeg mbəŋchubi|iməg ngwə̀t|iməg fog|iməg ichiibɔd|iməg àdùmbə̀ŋ|iməg ichika|iməg kud|iməg tèsiʼe|iməg zò|iməg krizmed',
  'Kohitātea|Huitanguru|Poutūterangi|Paengawhāwhā|Haratua|Pipiri|Hōngongoi|Hereturikōkā|Mahuru|Whiringa-ā-nuku|Whiringa-ā-rangi|Hakihea',
  'јануари|февруари|март|април|мај|јуни|јули|август|септември|октомври|ноември|декември',
  'ജനുവരി|ഫെബ്രുവരി|മാർച്ച്|ഏപ്രിൽ|മേയ്|ജൂൺ|ജൂലൈ|ഓഗസ്റ്റ്|സെപ്റ്റംബർ|ഒക്\u200cടോബർ|നവംബർ|ഡിസംബർ',
  'нэгдүгээр сар|хоёрдугаар сар|гуравдугаар сар|дөрөвдүгээр сар|тавдугаар сар|зургаадугаар сар|долоодугаар сар|наймдугаар сар|есдүгээр сар|аравдугаар сар|арван нэгдүгээр сар|арван хоёрдугаар сар',
  'জানুৱারি|ফেব্রুৱারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|ওক্টোবর|নভেম্বর|ডিসেম্বর',
  'जानेवारी|फेब्रुवारी|मार्च|एप्रिल|मे|जून|जुलै|ऑगस्ट|सप्टेंबर|ऑक्टोबर|नोव्हेंबर|डिसेंबर',
  'Januari|Februari|Mac|April|Mei|Jun|Julai|Ogos|September|Oktober|November|Disember',
  'Jannar|Frar|Marzu|April|Mejju|Ġunju|Lulju|Awwissu|Settembru|Ottubru|Novembru|Diċembru',
  'Fĩi Loo|Cokcwaklaŋne|Cokcwaklii|Fĩi Marfoo|Madǝǝuutǝbijaŋ|Mamǝŋgwãafahbii|Mamǝŋgwãalii|Madǝmbii|Fĩi Dǝɓlii|Fĩi Mundaŋ|Fĩi Gwahlle|Fĩi Yuru',
  'ဇန်နဝါရီ|ဖေဖော်ဝါရီ|မတ်|ဧပြီ|မေ|ဇွန်|ဇူလိုင်|ဩဂုတ်|စက်တင်ဘာ|အောက်တိုဘာ|နိုဝင်ဘာ|ဒီဇင်ဘာ',
  'ژانویه|فوریه|مارس|آوریل|مه|ژوئن|ژوئیه|اوت|سپتامبر|اکتبر|نوامبر|دسامبر',
  'ǃKhanni|ǃKhanǀgôab|ǀKhuuǁkhâb|ǃHôaǂkhaib|ǃKhaitsâb|Gamaǀaeb|ǂKhoesaob|Aoǁkhuumûǁkhâb|Taraǀkhuumûǁkhâb|ǂNûǁnâiseb|ǀHooǂgaeb|Hôasoreǁkhâb',
  'Zibandlela|Nhlolanja|Mbimbitho|Mabasa|Nkwenkwezi|Nhlangula|Ntulikazi|Ncwabakazi|Mpandula|Mfumfu|Lwezi|Mpalakazi',
  'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec',
  'जनवरी|फेब्रुअरी|मार्च|अप्रिल|मे|जुन|जुलाई|अगस्ट|सेप्टेम्बर|अक्टोबर|नोभेम्बर|डिसेम्बर',
  'ngwɛn matáhra|ngwɛn ńmba|ngwɛn ńlal|ngwɛn ńna|ngwɛn ńtan|ngwɛn ńtuó|ngwɛn hɛmbuɛrí|ngwɛn lɔmbi|ngwɛn rɛbvuâ|ngwɛn wum|ngwɛn wum navǔr|krísimin',
  'saŋ tsetsɛ̀ɛ lùm|saŋ kàg ngwóŋ|saŋ lepyè shúm|saŋ cÿó|saŋ tsɛ̀ɛ cÿó|saŋ njÿoláʼ|saŋ tyɛ̀b tyɛ̀b mbʉ̀ŋ|saŋ mbʉ̀ŋ|saŋ ngwɔ̀ʼ mbÿɛ|saŋ tàŋa tsetsáʼ|saŋ mejwoŋó|saŋ lùm',
  'Tiop thar pɛt|Pɛt|Duɔ̱ɔ̱ŋ|Guak|Duät|Kornyoot|Pay yie̱tni|Tho̱o̱r|Tɛɛr|Laath|Kur|Tio̱p in di̱i̱t',
  'Amajjii|Guraandhala|Bitooteessa|Elba|Caamsa|Waxabajjii|Adooleessa|Hagayya|Fuulbana|Onkololeessa|Sadaasa|Muddee',
  'ଜାନୁଆରୀ|ଫେବୃଆରୀ|ମାର୍ଚ୍ଚ|ଅପ୍ରେଲ|ମଇ|ଜୁନ|ଜୁଲାଇ|ଅଗଷ୍ଟ|ସେପ୍ଟେମ୍ବର|ଅକ୍ଟୋବର|ନଭେମ୍ବର|ଡିସେମ୍ବର',
  'январы|февралы|мартъийы|апрелы|майы|июны|июлы|августы|сентябры|октябры|ноябры|декабры',
  'ਜਨਵਰੀ|ਫ਼ਰਵਰੀ|ਮਾਰਚ|ਅਪ੍ਰੈਲ|ਮਈ|ਜੂਨ|ਜੁਲਾਈ|ਅਗਸਤ|ਸਤੰਬਰ|ਅਕਤੂਬਰ|ਨਵੰਬਰ|ਦਸੰਬਰ',
  'Jénúári|Fẹ́búári|Mach|Éprel|Mee|Jun|Julai|Ọgọst|Sẹptẹ́mba|Ọktóba|Nọvẹ́mba|Disẹ́mba',
  'stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia',
  'جنوري|فبروري|مارچ|اپریل|مۍ|جون|جولای|اګست|سېپتمبر|اکتوبر|نومبر|دسمبر',
  'Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Setiembre|Octubre|Noviembre|Diciembre',
  'da schaner|da favrer|da mars|d’avrigl|da matg|da zercladur|da fanadur|d’avust|da settember|d’october|da november|da december',
  'Nzero|Ruhuhuma|Ntwarante|Ndamukiza|Rusama|Ruheshi|Mukakaro|Nyandagaro|Nyakanga|Gitugutu|Munyonyo|Kigarama',
  'ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie',
  'Mweri wa kwanza|Mweri wa kaili|Mweri wa katatu|Mweri wa kaana|Mweri wa tanu|Mweri wa sita|Mweri wa saba|Mweri wa nane|Mweri wa tisa|Mweri wa ikumi|Mweri wa ikumi na moja|Mweri wa ikumi na mbili',
  'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря',
  'Mutarama|Gashyantare|Werurwe|Mata|Gicuransi|Kamena|Nyakanga|Kanama|Nzeli|Ukwakira|Ugushyingo|Ukuboza',
  'जनवरीमासः|फरवरीमासः|मार्चमासः|अप्रैलमासः|मईमासः|जूनमासः|जुलाईमासः|अगस्तमासः|सितंबरमासः|अक्तूबरमासः|नवंबरमासः|दिसंबरमासः',
  'Тохсунньу|Олунньу|Кулун тутар|Муус устар|Ыам ыйын|Бэс ыйын|От ыйын|Атырдьых ыйын|Балаҕан ыйын|Алтынньы|Сэтинньи|ахсынньы',
  'Lapa le obo|Lapa le waare|Lapa le okuni|Lapa le ong’wan|Lapa le imet|Lapa le ile|Lapa le sapa|Lapa le isiet|Lapa le saal|Lapa le tomon|Lapa le tomon obo|Lapa le tomon waare',
  'ᱡᱟᱱᱣᱟᱨᱤ|ᱯᱷᱟᱨᱣᱟᱨᱤ|ᱢᱟᱨᱪ|ᱟᱯᱨᱮᱞ|ᱢᱮ|ᱡᱩᱱ|ᱡᱩᱞᱟᱭ|ᱟᱜᱟᱥᱛ|ᱥᱮᱯᱴᱮᱢᱵᱟᱨ|ᱚᱠᱴᱚᱵᱟᱨ|ᱱᱟᱣᱟᱢᱵᱟᱨ|ᱫᱤᱥᱟᱢᱵᱟᱨ',
  'Mupalangulwa|Mwitope|Mushende|Munyi|Mushende Magali|Mujimbi|Mushipepo|Mupuguto|Munyense|Mokhu|Musongandembwe|Muhaano',
  'جنوري|فيبروري|مارچ|اپريل|مئي|جون|جولاءِ|آگسٽ|سيپٽمبر|آڪٽوبر|نومبر|ڊسمبر',
  'ođđajagemánnu|guovvamánnu|njukčamánnu|cuoŋománnu|miessemánnu|geassemánnu|suoidnemánnu|borgemánnu|čakčamánnu|golggotmánnu|skábmamánnu|juovlamánnu',
  'Janeiro|Fevreiro|Marco|Abril|Maio|Junho|Julho|Augusto|Setembro|Otubro|Novembro|Decembro',
  'Nyenye|Fulundïgi|Mbängü|Ngubùe|Bêläwü|Föndo|Lengua|Kükürü|Mvuka|Ngberere|Nabändüru|Kakauka',
  'ⵉⵏⵏⴰⵢⵔ|ⴱⵕⴰⵢⵕ|ⵎⴰⵕⵚ|ⵉⴱⵔⵉⵔ|ⵎⴰⵢⵢⵓ|ⵢⵓⵏⵢⵓ|ⵢⵓⵍⵢⵓⵣ|ⵖⵓⵛⵜ|ⵛⵓⵜⴰⵏⴱⵉⵔ|ⴽⵜⵓⴱⵔ|ⵏⵓⵡⴰⵏⴱⵉⵔ|ⴷⵓⵊⴰⵏⴱⵉⵔ',
  'ජනවාරි|පෙබරවාරි|මාර්තු|අප්\u200dරේල්|මැයි|ජූනි|ජූලි|අගෝස්තු|සැප්තැම්බර්|ඔක්තෝබර්|නොවැම්බර්|දෙසැම්බර්',
  'januára|februára|marca|apríla|mája|júna|júla|augusta|septembra|októbra|novembra|decembra',
  'januar|februar|marec|april|maj|junij|julij|avgust|september|oktober|november|december',
  'uđđâivemáánu|kuovâmáánu|njuhčâmáánu|cuáŋuimáánu|vyesimáánu|kesimáánu|syeinimáánu|porgemáánu|čohčâmáánu|roovvâdmáánu|skammâmáánu|juovlâmáánu',
  'Ndira|Kukadzi|Kurume|Kubvumbi|Chivabvu|Chikumi|Chikunguru|Nyamavhuvhu|Gunyana|Gumiguru|Mbudzi|Zvita',
  'Bisha Koobaad|Bisha Labaad|Bisha Saddexaad|Bisha Afraad|Bisha Shanaad|Bisha Lixaad|Bisha Todobaad|Bisha Sideedaad|Bisha Sagaalaad|Bisha Tobnaad|Bisha Kow iyo Tobnaad|Bisha Laba iyo Tobnaad',
  'janar|shkurt|mars|prill|maj|qershor|korrik|gusht|shtator|tetor|nëntor|dhjetor',
  'јануар|фебруар|март|април|мај|јун|јул|август|септембар|октобар|новембар|децембар',
  'јануар|фебруар|март|април|мај|јуни|јули|август|септембар|октобар|новембар|децембар',
  'Januari|Pébruari|Maret|April|Méi|Juni|Juli|Agustus|Séptémber|Oktober|Nopémber|Désémber',
  'ஜனவரி|பிப்ரவரி|மார்ச்|ஏப்ரல்|மே|ஜூன்|ஜூலை|ஆகஸ்ட்|செப்டம்பர்|அக்டோபர்|நவம்பர்|டிசம்பர்',
  'జనవరి|ఫిబ్రవరి|మార్చి|ఏప్రిల్|మే|జూన్|జులై|ఆగస్టు|సెప్టెంబర్|అక్టోబర్|నవంబర్|డిసెంబర్',
  'Orara|Omuk|Okwamg’|Odung’el|Omaruk|Omodok’king’ol|Ojola|Opedel|Osokosokoma|Otibar|Olabor|Opoo',
  'Январ|Феврал|Март|Апрел|Май|Июн|Июл|Август|Сентябр|Октябр|Ноябр|Декабр',
  'มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม',
  'ጥሪ|ለካቲት|መጋቢት|ሚያዝያ|ግንቦት|ሰነ|ሓምለ|ነሓሰ|መስከረም|ጥቅምቲ|ሕዳር|ታሕሳስ',
  'ýanwar|fewral|mart|aprel|maý|iýun|iýul|awgust|sentýabr|oktýabr|noýabr|dekabr',
  'Sānuali|Fēpueli|Maʻasi|ʻEpeleli|Mē|Sune|Siulai|ʻAokosi|Sepitema|ʻOkatopa|Nōvema|Tīsema',
  'Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık',
  'гыйнвар|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь',
  'Yennayer|Yebrayer|Mars|Ibrir|Mayyu|Yunyu|Yulyuz|Ɣuct|Cutanbir|Kṭuber|Nwanbir|Dujanbir',
  'يانۋار|فېۋرال|مارت|ئاپرېل|ماي|ئىيۇن|ئىيۇل|ئاۋغۇست|سېنتەبىر|ئۆكتەبىر|نويابىر|دېكابىر',
  'січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня',
  'جنوری|فروری|مارچ|اپریل|مئی|جون|جولائی|اگست|ستمبر|اکتوبر|نومبر|دسمبر',
  'yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sentabr|oktabr|noyabr|dekabr',
  'ꖨꖕ ꕪꕴ ꔞꔀꕮꕊ|ꕒꕡꖝꖕ|ꕾꖺ|ꖢꖕ|ꖑꕱ|ꖱꘋ|ꖱꕞꔤ|ꗛꔕ|ꕢꕌ|ꕭꖃ|ꔞꘋꕔꕿ ꕸꖃꗏ|ꖨꖕ ꕪꕴ ꗏꖺꕮꕊ',
  'tháng 1|tháng 2|tháng 3|tháng 4|tháng 5|tháng 6|tháng 7|tháng 8|tháng 9|tháng 10|tháng 11|tháng 12',
  'Jenner|Hornig|Märze|Abrille|Meije|Bráčet|Heiwet|Öigšte|Herbštmánet|Wímánet|Wintermánet|Chrištmánet',
  'Samwiyee|Fewriyee|Mars|Awril|Mee|Suwe|Sulet|Ut|Sàttumbar|Oktoobar|Nowàmbar|Desàmbar',
  'Janyuwari|Februwari|Matshi|Epreli|Meyi|Juni|Julayi|Agasti|Septemba|Okthoba|Novemba|Disemba',
  'pikítíkítie, oólí ú kutúan|siɛyɛ́, oóli ú kándíɛ|ɔnsúmbɔl, oóli ú kátátúɛ|mesiŋ, oóli ú kénie|ensil, oóli ú kátánuɛ|ɔsɔn|efute|pisuyú|imɛŋ i puɔs|imɛŋ i putúk,oóli ú kátíɛ|makandikɛ|pilɔndɔ́',
  'יאַנואַר|פֿעברואַר|מערץ|אַפּריל|מיי|יוני|יולי|אויגוסט|סעפּטעמבער|אקטאבער|נאוועמבער|דעצעמבער',
  'Oṣù Ṣẹ́rẹ́|Oṣù Èrèlè|Oṣù Ẹrẹ̀nà|Oṣù Ìgbé|Oṣù Ẹ̀bibi|Oṣù Òkúdu|Oṣù Agẹmọ|Oṣù Ògún|Oṣù Owewe|Oṣù Ọ̀wàrà|Oṣù Bélú|Oṣù Ọ̀pẹ̀',
  'Oshù Shɛ́rɛ́|Oshù Èrèlè|Oshù Ɛrɛ̀nà|Oshù Ìgbé|Oshù Ɛ̀bibi|Oshù Òkúdu|Oshù Agɛmɔ|Oshù Ògún|Oshù Owewe|Oshù Ɔ̀wàrà|Oshù Bélú|Oshù Ɔ̀pɛ̀',
  'Januwari|Februwari|Mashi|Ephreli|Meyi|Juni|Julayi|Agasti|Septhemba|Okthoba|Novemba|Disemba',
];

/** getShortMonths(), '|'-separated. */
const SHORT_MONTHS: readonly string[] = [
  'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec',
  '1月|2月|3月|4月|5月|6月|7月|8月|9月|10月|11月|12月',
  'jan.|feb.|mrt.|apr.|mei|jun.|jul.|aug.|sep.|okt.|nov.|dec.',
  'Jan|Feb|Mar|Apr|May|June|July|Aug|Sept|Oct|Nov|Dec',
  'Jan.|Feb.|Mar.|Apr.|May|Jun.|Jul.|Aug.|Sep.|Oct.|Nov.|Dec.',
  'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Oct|Nov|Dec',
  'janv.|févr.|mars|avr.|mai|juin|juil.|août|sept.|oct.|nov.|déc.',
  'janv.|févr.|mars|avr.|mai|juin|juill.|août|sept.|oct.|nov.|déc.',
  'Jän.|Feb.|März|Apr.|Mai|Juni|Juli|Aug.|Sep.|Okt.|Nov.|Dez.',
  'Jan.|Feb.|März|Apr.|Mai|Juni|Juli|Aug.|Sept.|Okt.|Nov.|Dez.',
  'gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic',
  '1월|2월|3월|4월|5월|6월|7월|8월|9월|10월|11월|12월',
  'jan.|feb.|mar.|apr.|mai|jun.|jul.|aug.|sep.|okt.|nov.|des.',
  'jan.|fev.|mar.|abr.|mai.|jun.|jul.|ago.|set.|out.|nov.|dez.',
  'ene.|feb.|mar.|abr.|may.|jun.|jul.|ago.|sep.|oct.|nov.|dic.',
  'ene|feb|mar|abr|may|jun|jul|ago|sept|oct|nov|dic',
  'jan.|feb.|mars|apr.|maj|juni|juli|aug.|sep.|okt.|nov.|dec.',
  'Jan.|Feb.|Mrt.|Apr.|Mei|Jun.|Jul.|Aug.|Sep.|Okt.|Nov.|Des.',
  'nùm|kɨz|tɨd|taa|see|nzu|dum|fɔe|dzu|lɔm|kaa|fwo',
  'S-Ɔ|K-Ɔ|E-Ɔ|E-O|E-K|O-A|A-K|D-Ɔ|F-Ɛ|Ɔ-A|Ɔ-O|M-Ɔ',
  'ጃንዩ|ፌብሩ|ማርች|ኤፕሪ|ሜይ|ጁን|ጁላይ|ኦገስ|ሴፕቴ|ኦክቶ|ኖቬም|ዲሴም',
  'يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر',
  'جانفي|فيفري|مارس|أفريل|ماي|جوان|جويلية|أوت|سبتمبر|أكتوبر|نوفمبر|ديسمبر',
  'كانون الثاني|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين\u00a0الأول|تشرين الثاني|كانون الأول',
  'كانون الثاني|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين الأول|تشرين الثاني|كانون الأول',
  'يناير|فبراير|مارس|أبريل|ماي|يونيو|يوليوز|غشت|شتنبر|أكتوبر|نونبر|دجنبر',
  'يناير|فبراير|مارس|إبريل|مايو|يونيو|يوليو|أغشت|شتمبر|أكتوبر|نوفمبر|دجمبر',
  'জানু|ফেব্ৰু|মাৰ্চ|এপ্ৰিল|মে’|জুন|জুলাই|আগ|ছেপ্তে|অক্টো|নৱে|ডিচে',
  'Jan|Feb|Mac|Apr|Mei|Jun|Jul|Ago|Sep|Okt|Nov|Dec',
  'xin|feb|mar|abr|may|xun|xnt|ago|set|och|pay|avi',
  'yan|fev|mar|apr|may|iyn|iyl|avq|sen|okt|noy|dek',
  'kɔn|mac|mat|mto|mpu|hil|nje|hik|dip|bio|may|liɓ',
  'сту|лют|сак|кра|мая|чэр|ліп|жні|вер|кас|ліс|сне',
  'Jan|Feb|Mac|Epr|Mei|Jun|Jul|Oga|Sep|Okt|Nov|Dis',
  'Hut|Vil|Dat|Tai|Han|Sit|Sab|Nan|Tis|Kum|Kmj|Kmb',
  'яну|фев|март|апр|май|юни|юли|авг|сеп|окт|ное|дек',
  'zan|feb|mar|awi|mɛ|zuw|zul|uti|sɛt|ɔku|now|des',
  'জানু|ফেব|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর',
  'ཟླ་༡|ཟླ་༢|ཟླ་༣|ཟླ་༤|ཟླ་༥|ཟླ་༦|ཟླ་༧|ཟླ་༨|ཟླ་༩|ཟླ་༡༠|ཟླ་༡༡|ཟླ་༡༢',
  'Gen.|Cʼhwe.|Meur.|Ebr.|Mae|Mezh.|Goue.|Eost|Gwen.|Here|Du|Kzu.',
  'जानुवारी|फेब्रुवारी|मार्स|एफ्रिल|मे|जुन|जुलाइ|आगस्थ|सेबथेज्ब़र|अखथबर|नबेज्ब़र|दिसेज्ब़र',
  'jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec',
  'de gen.|de febr.|de març|d’abr.|de maig|de juny|de jul.|d’ag.|de set.|d’oct.|de nov.|de des.',
  '𑄎𑄚𑄪|𑄜𑄬𑄛𑄴|𑄟𑄢𑄴𑄌𑄧|𑄃𑄬𑄛𑄳𑄢𑄨𑄣𑄴|𑄟𑄬|𑄎𑄪𑄚𑄴|𑄎𑄪𑄣𑄭|𑄃𑄉𑄧𑄌𑄴𑄑𑄴|𑄥𑄬𑄛𑄴𑄑𑄬𑄟𑄴𑄝𑄧𑄢𑄴|𑄃𑄧𑄇𑄴𑄑𑄮𑄝𑄧𑄢𑄴|𑄚𑄧𑄞𑄬𑄟𑄴𑄝𑄧𑄢𑄴|𑄓𑄨𑄥𑄬𑄟𑄴𑄝𑄢𑄴',
  'янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек',
  'Ene|Peb|Mar|Abr|May|Hun|Hul|Ago|Set|Okt|Nob|Dis',
  'KBZ|KBR|KST|KKN|KTN|KMK|KMS|KMN|KMW|KKM|KNK|KNB',
  'ᎤᏃ|ᎧᎦ|ᎠᏅ|ᎧᏬ|ᎠᏂ|ᏕᎭ|ᎫᏰ|ᎦᎶ|ᏚᎵ|ᏚᏂ|ᏅᏓ|ᎥᏍ',
  'کانوونی دووەم|شوبات|ئازار|نیسان|ئایار|حوزەیران|تەمووز|ئاب|ئەیلوول|تشرینی یەکەم|تشرینی دووەم|کانونی یەکەم',
  'led|úno|bře|dub|kvě|čvn|čvc|srp|zář|říj|lis|pro',
  'Ion|Chwef|Maw|Ebr|Mai|Meh|Gorff|Awst|Medi|Hyd|Tach|Rhag',
  'jan.|feb.|mar.|apr.|maj|jun.|jul.|aug.|sep.|okt.|nov.|dec.',
  'Imb|Kaw|Kad|Kan|Kas|Kar|Mfu|Wun|Ike|Iku|Imw|Iwi',
  'Žan|Fee|Mar|Awi|Me|Žuw|Žuy|Ut|Sek|Okt|Noo|Dee',
  'जन.|फर.|मार्च|अप्रैल|मेई|जून|जुलाई|अग.|सित.|अक्तू.|नव.|दिस.',
  'jan.|feb.|měr.|apr.|maj.|jun.|jul.|awg.|sep.|okt.|now.|dec.',
  'di|ŋgɔn|sɔŋ|diɓ|emi|esɔ|mad|diŋ|nyɛt|may|tin|elá',
  'Sa|Fe|Ma|Ab|Me|Su|Sú|Ut|Se|Ok|No|De',
  '༡|༢|༣|༤|༥|༦|༧|༨|༩|༡༠|༡༡|12',
  'Mbe|Kai|Kat|Kan|Gat|Gan|Mug|Knn|Ken|Iku|Imw|Igi',
  'dzv|dzd|ted|afɔ|dam|mas|sia|dea|any|kel|ade|dzm',
  'Ιαν|Φεβ|Μαρ|Απρ|Μαΐ|Ιουν|Ιουλ|Αυγ|Σεπ|Οκτ|Νοε|Δεκ',
  'jan|feb|mar|apr|maj|jun|jul|aŭg|sep|okt|nov|dec',
  'ene.|feb.|mar.|abr.|may.|jun.|jul.|ago.|set.|oct.|nov.|dic.',
  'ene.|feb.|mar.|abr.|may.|jun.|jul.|ago.|sept.|oct.|nov.|dic.',
  'jaan|veebr|märts|apr|mai|juuni|juuli|aug|sept|okt|nov|dets',
  'urt.|ots.|mar.|api.|mai.|eka.|uzt.|abu.|ira.|urr.|aza.|abe.',
  'ngo|ngb|ngl|ngn|ngt|ngs|ngz|ngm|nge|nga|ngad|ngab',
  'ژانویهٔ|فوریهٔ|مارس|آوریل|مهٔ|ژوئن|ژوئیهٔ|اوت|سپتامبر|اکتبر|نوامبر|دسامبر',
  'جنو|فبروری|مارچ|اپریل|می|جون|جول|اگست|سپتمبر|اکتوبر|نومبر|دسم',
  'sii|col|mbo|see|duu|kor|mor|juk|slt|yar|jol|bow',
  'tammik.|helmik.|maalisk.|huhtik.|toukok.|kesäk.|heinäk.|elok.|syysk.|lokak.|marrask.|jouluk.',
  'jan.|fév.|mar.|avr.|mai|jui.|juil.|août|sept.|oct.|nov.|déc.',
  'Zen|Fev|Mar|Avr|Mai|Jug|Lui|Avo|Set|Otu|Nov|Dic',
  'Jan|Feb|Mrt|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Des',
  'Ean|Feabh|Márta|Aib|Beal|Meith|Iúil|Lún|MFómh|DFómh|Samh|Noll',
  'Faoi|Gearr|Màrt|Gibl|Cèit|Ògmh|Iuch|Lùna|Sult|Dàmh|Samh|Dùbh',
  'xan.|feb.|mar.|abr.|maio|xuño|xul.|ago.|set.|out.|nov.|dec.',
  'Jan|Feb|Mär|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez',
  'જાન્યુ|ફેબ્રુ|માર્ચ|એપ્રિલ|મે|જૂન|જુલાઈ|ઑગસ્ટ|સપ્ટે|ઑક્ટો|નવે|ડિસે',
  'Can|Feb|Mac|Apr|Mei|Jun|Cul|Agt|Sep|Okt|Nob|Dis',
  'J-guer|T-arree|Mayrnt|Avrril|Boaldyn|M-souree|J-souree|Luanistyn|M-fouyir|J-fouyir|M-Houney|M-Nollick',
  'Jan|Fab|Mar|Afi|May|Yun|Yul|Agu|Sat|Okt|Nuw|Dis',
  'Ian.|Pep.|Mal.|ʻAp.|Mei|Iun.|Iul.|ʻAu.|Kep.|ʻOk.|Now.|Kek.',
  'ינו׳|פבר׳|מרץ|אפר׳|מאי|יוני|יולי|אוג׳|ספט׳|אוק׳|נוב׳|דצמ׳',
  'जन॰|फ़र॰|मार्च|अप्रैल|मई|जून|जुल॰|अग॰|सित॰|अक्तू॰|नव॰|दिस॰',
  'sij|velj|ožu|tra|svi|lip|srp|kol|ruj|lis|stu|pro',
  'jan.|feb.|měr.|apr.|mej.|jun.|jul.|awg.|sep.|okt.|now.|dec.',
  'jan.|febr.|márc.|ápr.|máj.|jún.|júl.|aug.|szept.|okt.|nov.|dec.',
  'հնվ|փտվ|մրտ|ապր|մյս|հնս|հլս|օգս|սեպ|հոկ|նոյ|դեկ',
  'jan|feb|mar|apr|mai|jun|jul|aug|sep|oct|nov|dec',
  'Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agu|Sep|Okt|Nov|Des',
  'Jen|Feb|Maa|Epr|Mee|Juu|Jul|Ọgọ|Sep|Ọkt|Nov|Dis',
  'ꋍꆪ|ꑍꆪ|ꌕꆪ|ꇖꆪ|ꉬꆪ|ꃘꆪ|ꏃꆪ|ꉆꆪ|ꈬꆪ|ꊰꆪ|ꊰꊪꆪ|ꊰꑋꆪ',
  'jan.|feb.|mar.|apr.|maí|jún.|júl.|ágú.|sep.|okt.|nóv.|des.',
  '1|2|3|4|5|6|7|8|9|10|11|12',
  'Nduŋmbi Saŋ|Pɛsaŋ Pɛ́pá|Pɛsaŋ Pɛ́tát|Pɛsaŋ Pɛ́nɛ́kwa|Pɛsaŋ Pataa|Pɛsaŋ Pɛ́nɛ́ntúkú|Pɛsaŋ Saambá|Pɛsaŋ Pɛ́nɛ́fɔm|Pɛsaŋ Pɛ́nɛ́pfúꞋú|Pɛsaŋ Nɛgɛ́m|Pɛsaŋ Ntsɔ̌pmɔ́|Pɛsaŋ Ntsɔ̌ppá',
  'Jan|Feb|Mac|Apr|Mei|Jun|Jul|Ago|Sep|Okt|Nov|Des',
  'Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agt|Sep|Okt|Nov|Des',
  'იან|თებ|მარ|აპრ|მაი|ივნ|ივლ|აგვ|სექ|ოქტ|ნოე|დეკ',
  'Yen|Fur|Meɣ|Yeb|May|Yun|Yul|Ɣuc|Cte|Tub|Nun|Duǧ',
  'Mbe|Kel|Ktũ|Kan|Ktn|Tha|Moo|Nya|Knd|Ĩku|Ĩkm|Ĩkl',
  'Jan|Feb|Mar|Abr|Mai|Jun|Jul|Ago|Set|Otu|Nuv|Diz',
  'JEN|WKR|WGT|WKN|WTN|WTD|WMJ|WNN|WKD|WIK|WMW|DIT',
  'қаң.|ақп.|нау.|сәу.|мам.|мау.|шіл.|там.|қыр.|қаз.|қар.|жел.',
  'pamba|wanja|mbiyɔ mɛndoŋgɔ|Nyɔlɔmbɔŋgɔ|Mɔnɔ ŋgbanja|Nyaŋgwɛ ŋgbanja|kuŋgwɛ|fɛ|njapi|nyukul|M11|ɓulɓusɛ',
  'jan|febr|mar|apr|maj|jun|jul|aug|sept|okt|nov|dec',
  'Mul|Ngat|Taa|Iwo|Mam|Paa|Nge|Roo|Bur|Epe|Kpt|Kpa',
  'មករា|កុម្ភៈ|មីនា|មេសា|ឧសភា|មិថុនា|កក្កដា|សីហា|កញ្ញា|តុលា|វិច្ឆិកា|ធ្នូ',
  'ಜನವರಿ|ಫೆಬ್ರವರಿ|ಮಾರ್ಚ್|ಏಪ್ರಿ|ಮೇ|ಜೂನ್|ಜುಲೈ|ಆಗ|ಸೆಪ್ಟೆಂ|ಅಕ್ಟೋ|ನವೆಂ|ಡಿಸೆಂ',
  'जानेवारी|फेब्रुवारी|मार्च|एप्रील|मे|जून|जुलय|ऑगस्ट|सप्टेंबर|ऑक्टोबर|नोव्हेंबर|डिसेंबर',
  'جنؤری|فرؤری|مارٕچ|اپریل|میٔ|جوٗن|جوٗلایی|اگست|ستمبر|اکتوٗبر|نومبر|دسمبر',
  'ŋ1|ŋ2|ŋ3|ŋ4|ŋ5|ŋ6|ŋ7|ŋ8|ŋ9|ŋ10|ŋ11|ŋ12',
  'Jan|Fäb|Mäz|Apr|Mai|Jun|Jul|Ouj|Säp|Okt|Nov|Dez',
  'rêb|reş|ada|avr|gul|pûş|tîr|gel|rez|kew|ser|ber',
  'Gen|Hwe|Meu|Ebr|Me|Met|Gor|Est|Gwn|Hed|Du|Kev',
  'янв.|фев.|мар.|апр.|май|июн.|июл.|авг.|сен.|окт.|ноя.|дек.',
  'Fúngatɨ|Naanɨ|Keenda|Ikúmi|Inyambala|Idwaata|Mʉʉnchɨ|Vɨɨrɨ|Saatʉ|Inyi|Saano|Sasatʉ',
  'Jan.|Feb.|Mäe.|Abr.|Mee|Juni|Juli|Aug.|Sep.|Okt.|Nov.|Dez.',
  'Jan|Feb|Mar|Apu|Maa|Juu|Jul|Agu|Seb|Oki|Nov|Des',
  'Wiótheȟika Wí|Thiyóȟeyuŋka Wí|Ištáwičhayazaŋ Wí|Pȟežítȟo Wí|Čhaŋwápetȟo Wí|Wípazukȟa-wašté Wí|Čhaŋpȟásapa Wí|Wasútȟuŋ Wí|Čhaŋwápeǧi Wí|Čhaŋwápe-kasná Wí|Waníyetu Wí|Tȟahékapšuŋ Wí',
  'yan|fbl|msi|apl|mai|yun|yul|agt|stb|ɔtb|nvb|dsb',
  'ມ.ກ.|ກ.ພ.|ມ.ນ.|ມ.ສ.|ພ.ພ.|ມິ.ຖ.|ກ.ລ.|ສ.ຫ.|ກ.ຍ.|ຕ.ລ.|ພ.ຈ.|ທ.ວ.',
  'جانڤیە|فئڤریە|مارس|آڤریل|مئی|جوٙأن|جوٙلا|آگوست|سئپتامر|ئوکتوڤر|نوڤامر|دئسامر',
  'saus.|vas.|kov.|bal.|geg.|birž.|liep.|rugp.|rugs.|spal.|lapkr.|gruod.',
  'Cio|Lui|Lus|Muu|Lum|Luf|Kab|Lush|Lut|Lun|Kas|Cis',
  'DAC|DAR|DAD|DAN|DAH|DAU|DAO|DAB|DOC|DAP|DGI|DAG',
  'Jan|Feb|Mar|Apr|Mei|Jun|Jul|Ago|Sep|Okt|Nov|Des',
  'janv.|febr.|marts|apr.|maijs|jūn.|jūl.|aug.|sept.|okt.|nov.|dec.',
  'Dal|Ará|Ɔɛn|Doy|Lép|Rok|Sás|Bɔ́r|Kús|Gís|Shʉ́|Ntʉ́',
  'JAN|FEB|MAC|ĨPU|MĨĨ|NJU|NJR|AGA|SPT|OKT|NOV|DEC',
  'zan|fev|mar|avr|me|zin|zil|out|sep|okt|nov|des',
  'Jan|Feb|Mar|Apr|Mey|Jon|Jol|Aog|Sep|Okt|Nov|Des',
  'Kwa|Una|Rar|Che|Tha|Moc|Sab|Nan|Tis|Kum|Moj|Yel',
  'mbegtug|imeg àbùbì|imeg mbəŋchubi|iməg ngwə̀t|iməg fog|iməg ichiibɔd|iməg àdùmbə̀ŋ|iməg ichika|iməg kud|iməg tèsiʼe|iməg zò|iməg krizmed',
  'Kohi|Hui|Pou|Pae|Hara|Pipi|Hōngo|Here|Mahu|Nuku|Rangi|Haki',
  'јан.|фев.|мар.|апр.|мај|јун.|јул.|авг.|септ.|окт.|ноем.|дек.',
  'ജനു|ഫെബ്രു|മാർ|ഏപ്രി|മേയ്|ജൂൺ|ജൂലൈ|ഓഗ|സെപ്റ്റം|ഒക്ടോ|നവം|ഡിസം',
  '1-р сар|2-р сар|3-р сар|4-р сар|5-р сар|6-р сар|7-р сар|8-р сар|9-р сар|10-р сар|11-р сар|12-р сар',
  'জানুৱারি|ফেব্রুৱারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|ওক্টোবর|নভেম্বর|ডিসেম্বর',
  'जाने|फेब्रु|मार्च|एप्रि|मे|जून|जुलै|ऑग|सप्टें|ऑक्टो|नोव्हें|डिसें',
  'Jan|Feb|Mac|Apr|Mei|Jun|Jul|Ogo|Sep|Okt|Nov|Dis',
  'Jan|Fra|Mar|Apr|Mej|Ġun|Lul|Aww|Set|Ott|Nov|Diċ',
  'FLO|CLA|CKI|FMF|MAD|MBI|MLI|MAM|FDE|FMU|FGW|FYU',
  'ဇန်|ဖေ|မတ်|ဧ|မေ|ဇွန်|ဇူ|ဩ|စက်|အောက်|နို|ဒီ',
  'ژانویه|فوریه|مارس|آوریل|مه|ژوئن|ژوئیه|اوت|سپتامبر|اکتبر|نوامبر|دسامبر',
  'Zib|Nhlo|Mbi|Mab|Nkw|Nhla|Ntu|Ncw|Mpan|Mfu|Lwe|Mpal',
  'जनवरी|फेब्रुअरी|मार्च|अप्रिल|मे|जुन|जुलाई|अगस्ट|सेप्टेम्बर|अक्टोबर|नोभेम्बर|डिसेम्बर',
  'ng1|ng2|ng3|ng4|ng5|ng6|ng7|ng8|ng9|ng10|ng11|kris',
  'jan.|feb.|mars|apr.|mai|juni|juli|aug.|sep.|okt.|nov.|des.',
  'saŋ tsetsɛ̀ɛ lùm|saŋ kàg ngwóŋ|saŋ lepyè shúm|saŋ cÿó|saŋ tsɛ̀ɛ cÿó|saŋ njÿoláʼ|saŋ tyɛ̀b tyɛ̀b mbʉ̀ŋ|saŋ mbʉ̀ŋ|saŋ ngwɔ̀ʼ mbÿɛ|saŋ tàŋa tsetsáʼ|saŋ mejwoŋó|saŋ lùm',
  'Tiop|Pɛt|Duɔ̱ɔ̱|Guak|Duä|Kor|Pay|Thoo|Tɛɛ|Laa|Kur|Tid',
  'Ama|Gur|Bit|Elb|Cam|Wax|Ado|Hag|Ful|Onk|Sad|Mud',
  'ଜାନୁଆରୀ|ଫେବୃଆରୀ|ମାର୍ଚ୍ଚ|ଅପ୍ରେଲ|ମଇ|ଜୁନ|ଜୁଲାଇ|ଅଗଷ୍ଟ|ସେପ୍ଟେମ୍ବର|ଅକ୍ଟୋବର|ନଭେମ୍ବର|ଡିସେମ୍ବର',
  'янв.|фев.|мар.|апр.|майы|июны|июлы|авг.|сен.|окт.|ноя.|дек.',
  'ਜਨ|ਫ਼ਰ|ਮਾਰਚ|ਅਪ੍ਰੈ|ਮਈ|ਜੂਨ|ਜੁਲਾ|ਅਗ|ਸਤੰ|ਅਕਤੂ|ਨਵੰ|ਦਸੰ',
  'Jén|Fẹ́b|Mach|Épr|Mee|Jun|Jul|Ọgọ|Sẹp|Ọkt|Nọv|Dis',
  'sty|lut|mar|kwi|maj|cze|lip|sie|wrz|paź|lis|gru',
  'جنوري|فبروري|مارچ|اپریل|مۍ|جون|جولای|اګست|سېپتمبر|اکتوبر|نومبر|دسمبر',
  'Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Set|Oct|Nov|Dic',
  'schan.|favr.|mars|avr.|matg|zercl.|fan.|avust|sett.|oct.|nov.|dec.',
  'Mut.|Gas.|Wer.|Mat.|Gic.|Kam.|Nya.|Kan.|Nze.|Ukw.|Ugu.|Uku.',
  'ian.|feb.|mar.|apr.|mai|iun.|iul.|aug.|sept.|oct.|nov.|dec.',
  'M1|M2|M3|M4|M5|M6|M7|M8|M9|M10|M11|M12',
  'янв.|февр.|мар.|апр.|мая|июн.|июл.|авг.|сент.|окт.|нояб.|дек.',
  'mut.|gas.|wer.|mat.|gic.|kam.|nya.|kan.|nze.|ukw.|ugu.|uku.',
  'जनवरी:|फरवरी:|मार्च:|अप्रैल:|मई|जून:|जुलाई:|अगस्त:|सितंबर:|अक्तूबर:|नवंबर:|दिसंबर:',
  'Тохс|Олун|Клн|Мсу|Ыам|Бэс|Отй|Атр|Блҕ|Алт|Сэт|Ахс',
  'Obo|Waa|Oku|Ong|Ime|Ile|Sap|Isi|Saa|Tom|Tob|Tow',
  'ᱡᱟᱱ|ᱯᱷᱟ|ᱢᱟᱨ|ᱟᱯᱨ|ᱢᱮ|ᱡᱩᱱ|ᱡᱩᱞ|ᱟᱜᱟ|ᱥᱮᱯ|ᱚᱠᱴ|ᱱᱟᱣ|ᱫᱤᱥ',
  'Mup|Mwi|Msh|Mun|Mag|Muj|Msp|Mpg|Mye|Mok|Mus|Muh',
  'جنوري|فيبروري|مارچ|اپريل|مئي|جون|جولاءِ|آگسٽ|سيپٽمبر|آڪٽوبر|نومبر|ڊسمبر',
  'ođđj|guov|njuk|cuo|mies|geas|suoi|borg|čakč|golg|skáb|juov',
  'ođđj|guov|njuk|cuoŋ|mies|geas|suoi|borg|čakč|golg|skáb|juov',
  'Jan|Fev|Mar|Abr|Mai|Jun|Jul|Aug|Set|Otu|Nov|Dec',
  'Nye|Ful|Mbä|Ngu|Bêl|Fön|Len|Kük|Mvu|Ngb|Nab|Kak',
  'ⵉⵏⵏ|ⴱⵕⴰ|ⵎⴰⵕ|ⵉⴱⵔ|ⵎⴰⵢ|ⵢⵓⵏ|ⵢⵓⵍ|ⵖⵓⵛ|ⵛⵓⵜ|ⴽⵜⵓ|ⵏⵓⵡ|ⴷⵓⵊ',
  'ජන|පෙබ|මාර්තු|අප්\u200dරේල්|මැයි|ජූනි|ජූලි|අගෝ|සැප්|ඔක්|නොවැ|දෙසැ',
  'jan|feb|mar|apr|máj|jún|júl|aug|sep|okt|nov|dec',
  'jan.|feb.|mar.|apr.|maj|jun.|jul.|avg.|sep.|okt.|nov.|dec.',
  'uđiv|kuovâ|njuhčâ|cuáŋui|vyesi|kesi|syeini|porge|čohčâ|roovvâd|skammâ|juovlâ',
  'Ndi|Kuk|Kur|Kub|Chv|Chk|Chg|Nya|Gun|Gum|Mbu|Zvi',
  'Jan|Feb|Mar|Abr|May|Jun|Lul|Ogs|Seb|Okt|Nof|Dis',
  'jan|shk|mar|pri|maj|qer|korr|gush|sht|tet|nën|dhj',
  'јан|феб|мар|апр|мај|јун|јул|авг|сеп|окт|нов|дец',
  'Jan|Péb|Mar|Apr|Méi|Jun|Jul|Ags|Sép|Okt|Nop|Dés',
  'ஜன.|பிப்.|மார்.|ஏப்.|மே|ஜூன்|ஜூலை|ஆக.|செப்.|அக்.|நவ.|டிச.',
  'జన|ఫిబ్ర|మార్చి|ఏప్రి|మే|జూన్|జులై|ఆగ|సెప్టెం|అక్టో|నవం|డిసెం',
  'Rar|Muk|Kwa|Dun|Mar|Mod|Jol|Ped|Sok|Tib|Lab|Poo',
  'Янв|Фев|Мар|Апр|Май|Июн|Июл|Авг|Сен|Окт|Ноя|Дек',
  'ม.ค.|ก.พ.|มี.ค.|เม.ย.|พ.ค.|มิ.ย.|ก.ค.|ส.ค.|ก.ย.|ต.ค.|พ.ย.|ธ.ค.',
  'ጥሪ|ለካ|መጋ|ሚያ|ግን|ሰነ|ሓም|ነሓ|መስ|ጥቅ|ሕዳ|ታሕ',
  'ýan|few|mart|apr|maý|iýun|iýul|awg|sen|okt|noý|dek',
  'Sān|Fēp|Maʻa|ʻEpe|Mē|Sun|Siu|ʻAok|Sep|ʻOka|Nōv|Tīs',
  'Oca|Şub|Mar|Nis|May|Haz|Tem|Ağu|Eyl|Eki|Kas|Ara',
  'гыйн.|фев.|мар.|апр.|май|июнь|июль|авг.|сент.|окт.|нояб.|дек.',
  'Yen|Yeb|Mar|Ibr|May|Yun|Yul|Ɣuc|Cut|Kṭu|Nwa|Duj',
  'يانۋار|فېۋرال|مارت|ئاپرېل|ماي|ئىيۇن|ئىيۇل|ئاۋغۇست|سېنتەبىر|ئۆكتەبىر|نويابىر|دېكابىر',
  'січ.|лют.|бер.|квіт.|трав.|черв.|лип.|серп.|вер.|жовт.|лист.|груд.',
  'جنوری|فروری|مارچ|اپریل|مئی|جون|جولائی|اگست|ستمبر|اکتوبر|نومبر|دسمبر',
  'yan|fev|mar|apr|may|iyn|iyl|avg|sen|okt|noy|dek',
  'ꖨꖕꔞ|ꕒꕡ|ꕾꖺ|ꖢꖕ|ꖑꕱ|ꖱꘋ|ꖱꕞ|ꗛꔕ|ꕢꕌ|ꕭꖃ|ꔞꘋ|ꖨꖕꗏ',
  'thg 1|thg 2|thg 3|thg 4|thg 5|thg 6|thg 7|thg 8|thg 9|thg 10|thg 11|thg 12',
  'Jen|Hor|Mär|Abr|Mei|Brá|Hei|Öig|Her|Wím|Win|Chr',
  'Sam|Few|Mar|Awr|Mee|Suw|Sul|Ut|Sàt|Okt|Now|Des',
  'Jan|Feb|Mat|Epr|Mey|Jun|Jul|Aga|Sep|Okt|Nov|Dis',
  'o.1|o.2|o.3|o.4|o.5|o.6|o.7|o.8|o.9|o.10|o.11|o.12',
  'יאַנואַר|פֿעברואַר|מערץ|אַפּריל|מיי|יוני|יולי|אויגוסט|סעפּטעמבער|אקטאבער|נאוועמבער|דעצעמבער',
  'Ṣẹ́r|Èrèl|Ẹrẹ̀n|Ìgb|Ẹ̀bi|Òkú|Agẹ|Ògú|Owe|Ọ̀wà|Bél|Ọ̀pẹ',
  'Shɛ́r|Èrèl|Ɛrɛ̀n|Ìgb|Ɛ̀bi|Òkú|Agɛ|Ògú|Owe|Ɔ̀wà|Bél|Ɔ̀pɛ',
  '一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月',
  'Jan|Feb|Mas|Eph|Mey|Jun|Jul|Aga|Sep|Okt|Nov|Dis',
];

/** getWeekdays(), '|'-separated. */
const WEEKDAYS: readonly string[] = [
  'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday',
  '星期日|星期一|星期二|星期三|星期四|星期五|星期六',
  'zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag',
  'dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi',
  'Sonntag|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag',
  'domenica|lunedì|martedì|mercoledì|giovedì|venerdì|sabato',
  '日曜日|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日',
  '일요일|월요일|화요일|수요일|목요일|금요일|토요일',
  'søndag|mandag|tirsdag|onsdag|torsdag|fredag|lørdag',
  'domingo|segunda-feira|terça-feira|quarta-feira|quinta-feira|sexta-feira|sábado',
  'domingo|lunes|martes|miércoles|jueves|viernes|sábado',
  'söndag|måndag|tisdag|onsdag|torsdag|fredag|lördag',
  'Sondag|Maandag|Dinsdag|Woensdag|Donderdag|Vrydag|Saterdag',
  'tsuʔntsɨ|tsuʔukpà|tsuʔughɔe|tsuʔutɔ̀mlò|tsuʔumè|tsuʔughɨ̂m|tsuʔndzɨkɔʔɔ',
  'Kwesida|Dwowda|Benada|Wukuda|Yawda|Fida|Memeneda',
  'እሑድ|ሰኞ|ማክሰኞ|ረቡዕ|ሐሙስ|ዓርብ|ቅዳሜ',
  'الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت',
  'দেওবাৰ|সোমবাৰ|মঙ্গলবাৰ|বুধবাৰ|বৃহস্পতিবাৰ|শুক্ৰবাৰ|শনিবাৰ',
  'Jumapili|Jumatatu|Jumanne|Jumatano|Alhamisi|Ijumaa|Jumamosi',
  'domingu|llunes|martes|miércoles|xueves|vienres|sábadu',
  'bazar|bazar ertəsi|çərşənbə axşamı|çərşənbə|cümə axşamı|cümə|şənbə',
  'ŋgwà nɔ̂y|ŋgwà njaŋgumba|ŋgwà ûm|ŋgwà ŋgê|ŋgwà mbɔk|ŋgwà kɔɔ|ŋgwà jôn',
  'нядзеля|панядзелак|аўторак|серада|чацвер|пятніца|субота',
  'Pa Mulungu|Palichimo|Palichibuli|Palichitatu|Palichine|Palichisano|Pachibelushi',
  'pa mulungu|pa shahuviluha|pa hivili|pa hidatu|pa hitayi|pa hihanu|pa shahulembela',
  'неделя|понеделник|вторник|сряда|четвъртък|петък|събота',
  'kari|ntɛnɛ|tarata|araba|alamisa|juma|sibiri',
  'রবিবার|সোমবার|মঙ্গলবার|বুধবার|বৃহস্পতিবার|শুক্রবার|শনিবার',
  'གཟའ་ཉི་མ་|གཟའ་ཟླ་བ་|གཟའ་མིག་དམར་|གཟའ་ལྷག་པ་|གཟའ་ཕུར་བུ་|གཟའ་པ་སངས་|གཟའ་སྤེན་པ་',
  'Sul|Lun|Meurzh|Mercʼher|Yaou|Gwener|Sadorn',
  'रबिबार|समबार|मंगलबार|बुदबार|बिसथिबार|सुखुरबार|सुनिबार',
  'nedjelja|ponedjeljak|utorak|srijeda|četvrtak|petak|subota',
  'diumenge|dilluns|dimarts|dimecres|dijous|divendres|dissabte',
  '𑄢𑄧𑄝𑄨𑄝𑄢𑄴|𑄥𑄧𑄟𑄴𑄝𑄢𑄴|𑄟𑄧𑄁𑄉𑄧𑄣𑄴𑄝𑄢𑄴|𑄝𑄪𑄖𑄴𑄝𑄢𑄴|𑄝𑄳𑄢𑄨𑄥𑄪𑄛𑄴𑄝𑄢𑄴|𑄥𑄪𑄇𑄴𑄇𑄮𑄢𑄴𑄝𑄢𑄴|𑄥𑄧𑄚𑄨𑄝𑄢𑄴',
  'кӀира|оршот|шинара|кхаара|еара|пӀераска|шуот',
  'Domingo|Lunes|Martes|Miyerkules|Huwebes|Biyernes|Sabado',
  'Sande|Orwokubanza|Orwakabiri|Orwakashatu|Orwakana|Orwakataano|Orwamukaaga',
  'ᎤᎾᏙᏓᏆᏍᎬ|ᎤᎾᏙᏓᏉᏅᎯ|ᏔᎵᏁᎢᎦ|ᏦᎢᏁᎢᎦ|ᏅᎩᏁᎢᎦ|ᏧᎾᎩᎶᏍᏗ|ᎤᎾᏙᏓᏈᏕᎾ',
  'یەکشەممە|دووشەممە|سێشەممە|چوارشەممە|پێنجشەممە|ھەینی|شەممە',
  'neděle|pondělí|úterý|středa|čtvrtek|pátek|sobota',
  'Dydd Sul|Dydd Llun|Dydd Mawrth|Dydd Mercher|Dydd Iau|Dydd Gwener|Dydd Sadwrn',
  'Ituku ja jumwa|Kuramuka jimweri|Kuramuka kawi|Kuramuka kadadu|Kuramuka kana|Kuramuka kasanu|Kifula nguwo',
  'Alhadi|Atinni|Atalaata|Alarba|Alhamisi|Alzuma|Asibti',
  'ऐतबार|सोमबार|मंगलबार|बुधबार|बीरबार|शुक्रबार|शनीबार',
  'njeźela|pónjeźele|wałtora|srjoda|stwórtk|pětk|sobota',
  'éti|mɔ́sú|kwasú|mukɔ́sú|ŋgisú|ɗónɛsú|esaɓasú',
  'Dimas|Teneŋ|Talata|Alarbay|Aramisay|Arjuma|Sibiti',
  'གཟའ་ཟླ་བ་|གཟའ་མིག་དམར་|གཟའ་ལྷག་པ་|གཟའ་ཕུར་བུ་|གཟའ་པ་སངས་|གཟའ་སྤེན་པ་|གཟའ་ཉི་མ་',
  'Kiumia|Njumatatu|Njumaine|Njumatano|Aramithi|Njumaa|NJumamothii',
  'kɔsiɖa|dzoɖa|blaɖa|kuɖa|yawoɖa|fiɖa|memleɖa',
  'Κυριακή|Δευτέρα|Τρίτη|Τετάρτη|Πέμπτη|Παρασκευή|Σάββατο',
  'dimanĉo|lundo|mardo|merkredo|ĵaŭdo|vendredo|sabato',
  'pühapäev|esmaspäev|teisipäev|kolmapäev|neljapäev|reede|laupäev',
  'igandea|astelehena|asteartea|asteazkena|osteguna|ostirala|larunbata',
  'sɔ́ndɔ|mɔ́ndi|sɔ́ndɔ məlú mə́bɛ̌|sɔ́ndɔ məlú mə́lɛ́|sɔ́ndɔ məlú mə́nyi|fúladé|séradé',
  'یکشنبه|دوشنبه|سه\u200cشنبه|چهارشنبه|پنجشنبه|جمعه|شنبه',
  'dewo|aaɓnde|mawbaare|njeslaare|naasaande|mawnde|hoore-biir',
  'sunnuntaina|maanantaina|tiistaina|keskiviikkona|torstaina|perjantaina|lauantaina',
  'Linggo|Lunes|Martes|Miyerkules|Huwebes|Biyernes|Sabado',
  'sunnudagur|mánadagur|týsdagur|mikudagur|hósdagur|fríggjadagur|leygardagur',
  'domenie|lunis|martars|miercus|joibe|vinars|sabide',
  'snein|moandei|tiisdei|woansdei|tongersdei|freed|sneon',
  'Dé Domhnaigh|Dé Luain|Dé Máirt|Dé Céadaoin|Déardaoin|Dé hAoine|Dé Sathairn',
  'DiDòmhnaich|DiLuain|DiMàirt|DiCiadain|DiarDaoin|DihAoine|DiSathairne',
  'domingo|luns|martes|mércores|xoves|venres|sábado',
  'Sunntig|Määntig|Ziischtig|Mittwuch|Dunschtig|Friitig|Samschtig',
  'રવિવાર|સોમવાર|મંગળવાર|બુધવાર|ગુરુવાર|શુક્રવાર|શનિવાર',
  'Chumapiri|Chumatato|Chumaine|Chumatano|Aramisi|Ichuma|Esabato',
  'Jedoonee|Jelhein|Jemayrt|Jercean|Jerdein|Jeheiney|Jesarn',
  'Lahadi|Litinin|Talata|Laraba|Alhamis|Jummaʼa|Asabar',
  'Lāpule|Poʻakahi|Poʻalua|Poʻakolu|Poʻahā|Poʻalima|Poʻaono',
  'יום ראשון|יום שני|יום שלישי|יום רביעי|יום חמישי|יום שישי|יום שבת',
  'रविवार|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार',
  'njedźela|póndźela|wutora|srjeda|štwórtk|pjatk|sobota',
  'vasárnap|hétfő|kedd|szerda|csütörtök|péntek|szombat',
  'կիրակի|երկուշաբթի|երեքշաբթի|չորեքշաբթի|հինգշաբթի|ուրբաթ|շաբաթ',
  'dominica|lunedi|martedi|mercuridi|jovedi|venerdi|sabbato',
  'Minggu|Senin|Selasa|Rabu|Kamis|Jumat|Sabtu',
  'Sọndee|Mọnde|Tiuzdee|Wenezdee|Tọọzdee|Fraịdee|Satọdee',
  'ꑭꆏꑍ|ꆏꊂꋍ|ꆏꊂꑍ|ꆏꊂꌕ|ꆏꊂꇖ|ꆏꊂꉬ|ꆏꊂꃘ',
  'sunnudagur|mánudagur|þriðjudagur|miðvikudagur|fimmtudagur|föstudagur|laugardagur',
  'Sɔ́ndi|Mɔ́ndi|Ápta Mɔ́ndi|Wɛ́nɛsɛdɛ|Tɔ́sɛdɛ|Fɛlâyɛdɛ|Sásidɛ',
  'Jumapilyi|Jumatatuu|Jumanne|Jumatanu|Alhamisi|Ijumaa|Jumamosi',
  'Ahad|Senin|Selasa|Rabu|Kamis|Jumat|Sabtu',
  'კვირა|ორშაბათი|სამშაბათი|ოთხშაბათი|ხუთშაბათი|პარასკევი|შაბათი',
  'Yanass|Sanass|Kraḍass|Kuẓass|Samass|Sḍisass|Sayass',
  'Wa kyumwa|Wa kwambĩlĩlya|Wa kelĩ|Wa katatũ|Wa kana|Wa katano|Wa thanthatũ',
  'Liduva lyapili|Liduva lyatatu|Liduva lyanchechi|Liduva lyannyano|Liduva lyannyano na linji|Liduva lyannyano na mavili|Liduva litandi',
  'dumingu|sigunda-fera|tersa-fera|kuarta-fera|kinta-fera|sesta-fera|sábadu',
  'Alhadi|Atini|Atalata|Alarba|Alhamiisa|Aljuma|Assabdu',
  'Kiumia|Njumatatũ|Njumaine|Njumatana|Aramithi|Njumaa|Njumamothi',
  'жексенбі|дүйсенбі|сейсенбі|сәрсенбі|бейсенбі|жұма|сенбі',
  'sɔndi|lundi|mardi|mɛrkɛrɛdi|yedi|vaŋdɛrɛdi|mɔnɔ sɔndi',
  'sapaat|ataasinngorneq|marlunngorneq|pingasunngorneq|sisamanngorneq|tallimanngorneq|arfininngorneq',
  'Kotisap|Kotaai|Koaeng’|Kosomok|Koang’wan|Komuut|Kolo',
  'អាទិត្យ|ច័ន្ទ|អង្គារ|ពុធ|ព្រហស្បតិ៍|សុក្រ|សៅរ៍',
  'ಭಾನುವಾರ|ಸೋಮವಾರ|ಮಂಗಳವಾರ|ಬುಧವಾರ|ಗುರುವಾರ|ಶುಕ್ರವಾರ|ಶನಿವಾರ',
  'आयतार|सोमार|मंगळार|बुधवार|बिरेस्तार|शुक्रार|शेनवार',
  'اَتھوار|ژٔندرٕروار|بۆموار|بودوار|برؠسوار|جُمہ|بٹوار',
  'Jumaapii|Jumaatatu|Jumaane|Jumaatano|Alhamisi|Ijumaa|Jumaamosi',
  'sɔ́ndǝ|lǝndí|maadí|mɛkrɛdí|jǝǝdí|júmbá|samdí',
  'Sunndaach|Mohndaach|Dinnsdaach|Metwoch|Dunnersdaach|Friidaach|Samsdaach',
  'yekşem|duşem|sêşem|çarşem|pêncşem|în|şemî',
  'dy Sul|dy Lun|dy Meurth|dy Merher|dy Yow|dy Gwener|dy Sadorn',
  'жекшемби|дүйшөмбү|шейшемби|шаршемби|бейшемби|жума|ишемби',
  'Jumapíiri|Jumatátu|Jumaíne|Jumatáano|Alamíisi|Ijumáa|Jumamóosi',
  'Sonndeg|Méindeg|Dënschdeg|Mëttwoch|Donneschdeg|Freideg|Samschdeg',
  'Sabbiiti|Balaza|Lwakubiri|Lwakusatu|Lwakuna|Lwakutaano|Lwamukaaga',
  'Aŋpétuwakȟaŋ|Aŋpétuwaŋži|Aŋpétunuŋpa|Aŋpétuyamni|Aŋpétutopa|Aŋpétuzaptaŋ|Owáŋgyužažapi',
  'eyenga|mokɔlɔ mwa yambo|mokɔlɔ mwa míbalé|mokɔlɔ mwa mísáto|mokɔlɔ ya mínéi|mokɔlɔ ya mítáno|mpɔ́sɔ',
  'ວັນອາທິດ|ວັນຈັນ|ວັນອັງຄານ|ວັນພຸດ|ວັນພະຫັດ|ວັນສຸກ|ວັນເສົາ',
  'Sun|Mon|Tue|Wed|Thu|Fri|Sat',
  'sekmadienis|pirmadienis|antradienis|trečiadienis|ketvirtadienis|penktadienis|šeštadienis',
  'Lumingu|Nkodya|Ndàayà|Ndangù|Njòwa|Ngòvya|Lubingu',
  'Jumapil|Wuok Tich|Tich Ariyo|Tich Adek|Tich Ang’wen|Tich Abich|Ngeso',
  'Jumapiri|Jumatatu|Jumanne|Jumatano|Murwa wa Kanne|Murwa wa Katano|Jumamosi',
  'svētdiena|pirmdiena|otrdiena|trešdiena|ceturtdiena|piektdiena|sestdiena',
  'Jumapílí|Jumatátu|Jumane|Jumatánɔ|Alaámisi|Jumáa|Jumamósi',
  'Kiumia|Muramuko|Wairi|Wethatu|Wena|Wetano|Jumamosi',
  'dimans|lindi|mardi|merkredi|zedi|vandredi|samdi',
  'Alahady|Alatsinainy|Talata|Alarobia|Alakamisy|Zoma|Asabotsy',
  'Sabato|Jumatatu|Jumanne|Jumatano|Arahamisi|Ijumaa|Jumamosi',
  'Aneg 1|Aneg 2|Aneg 3|Aneg 4|Aneg 5|Aneg 6|Aneg 7',
  'Rātapu|Rāhina|Rātū|Rāapa|Rāpare|Rāmere|Rāhoroi',
  'недела|понеделник|вторник|среда|четврток|петок|сабота',
  'ഞായറാഴ്\u200cച|തിങ്കളാഴ്\u200cച|ചൊവ്വാഴ്ച|ബുധനാഴ്\u200cച|വ്യാഴാഴ്\u200cച|വെള്ളിയാഴ്\u200cച|ശനിയാഴ്\u200cച',
  'ням|даваа|мягмар|лхагва|пүрэв|баасан|бямба',
  'নোংমাইজিং|নিংথৌকাবা|লৈবাকপোকপা|য়ুমশকৈশা|শগোলশেন|ইরাই|থাংজ',
  'रविवार|सोमवार|मंगळवार|बुधवार|गुरुवार|शुक्रवार|शनिवार',
  'Ahad|Isnin|Selasa|Rabu|Khamis|Jumaat|Sabtu',
  'Il-Ħadd|It-Tnejn|It-Tlieta|L-Erbgħa|Il-Ħamis|Il-Ġimgħa|Is-Sibt',
  'Com’yakke|Comlaaɗii|Comzyiiɗii|Comkolle|Comkaldǝɓlii|Comgaisuu|Comzyeɓsuu',
  'တနင်္ဂနွေ|တနင်္လာ|အင်္ဂါ|ဗုဒ္ဓဟူး|ကြာသပတေး|သောကြာ|စနေ',
  'Sontaxtsees|Mantaxtsees|Denstaxtsees|Wunstaxtsees|Dondertaxtsees|Fraitaxtsees|Satertaxtsees',
  'Sonto|Mvulo|Sibili|Sithathu|Sine|Sihlanu|Mgqibelo',
  'आइतबार|सोमबार|मङ्गलबार|बुधबार|बिहिबार|शुक्रबार|शनिबार',
  'sɔ́ndɔ|mɔ́ndɔ|sɔ́ndɔ mafú mába|sɔ́ndɔ mafú málal|sɔ́ndɔ mafú mána|mabágá má sukul|sásadi',
  'søndag|måndag|tysdag|onsdag|torsdag|fredag|laurdag',
  'lyɛʼɛ́ sẅíŋtè|mvfò lyɛ̌ʼ|mbɔ́ɔntè mvfò lyɛ̌ʼ|tsètsɛ̀ɛ lyɛ̌ʼ|mbɔ́ɔntè tsetsɛ̀ɛ lyɛ̌ʼ|mvfò màga lyɛ̌ʼ|màga lyɛ̌ʼ',
  'Cäŋ kuɔth|Jiec la̱t|Rɛw lätni|Diɔ̱k lätni|Ŋuaan lätni|Dhieec lätni|Bäkɛl lätni',
  'Dilbata|Wiixata|Qibxata|Roobii|Kamiisa|Jimaata|Sanbata',
  'ରବିବାର|ସୋମବାର|ମଙ୍ଗଳବାର|ବୁଧବାର|ଗୁରୁବାର|ଶୁକ୍ରବାର|ଶନିବାର',
  'хуыцаубон|къуырисӕр|дыццӕг|ӕртыццӕг|цыппӕрӕм|майрӕмбон|сабат',
  'ਐਤਵਾਰ|ਸੋਮਵਾਰ|ਮੰਗਲਵਾਰ|ਬੁੱਧਵਾਰ|ਵੀਰਵਾਰ|ਸ਼ੁੱਕਰਵਾਰ|ਸ਼ਨਿੱਚਰਵਾਰ',
  'Sọ́ndè|Mọ́ndè|Tiúzdè|Wẹ́nẹ́zdè|Tọ́zdè|Fraídè|Sátọdè',
  'niedziela|poniedziałek|wtorek|środa|czwartek|piątek|sobota',
  'يونۍ|دونۍ|درېنۍ|څلرنۍ|پينځنۍ|جمعه|اونۍ',
  'Domingo|Lunes|Martes|Miércoles|Jueves|Viernes|Sábado',
  'dumengia|glindesdi|mardi|mesemna|gievgia|venderdi|sonda',
  'Ku w’indwi|Ku wa mbere|Ku wa kabiri|Ku wa gatatu|Ku wa kane|Ku wa gatanu|Ku wa gatandatu',
  'duminică|luni|marți|miercuri|joi|vineri|sâmbătă',
  'Ijumapili|Ijumatatu|Ijumanne|Ijumatano|Alhamisi|Ijumaa|Ijumamosi',
  'воскресенье|понедельник|вторник|среда|четверг|пятница|суббота',
  'Ku cyumweru|Kuwa mbere|Kuwa kabiri|Kuwa gatatu|Kuwa kane|Kuwa gatanu|Kuwa gatandatu',
  'रविवासरः|सोमवासरः|मंगलवासरः|बुधवासरः|गुरुवासर:|शुक्रवासरः|शनिवासरः',
  'баскыһыанньа|бэнидиэнньик|оптуорунньук|сэрэдэ|чэппиэр|Бээтиҥсэ|субуота',
  'Mderot ee are|Mderot ee kuni|Mderot ee ong’wan|Mderot ee inet|Mderot ee ile|Mderot ee sapa|Mderot ee kwe',
  'ᱥᱤᱸᱜᱮ|ᱚᱛᱮ|ᱵᱟᱞᱮ|ᱥᱟᱹᱜᱩᱱ|ᱥᱟᱹᱨᱫᱤ|ᱡᱟᱹᱨᱩᱢ|ᱧᱩᱦᱩᱢ',
  'Mulungu|Jumatatu|Jumanne|Jumatano|Alahamisi|Ijumaa|Jumamosi',
  'آچر|سومر|اڱارو|اربع|خميس|جمعو|ڇنڇر',
  'sotnabeaivi|vuossárga|maŋŋebárga|gaskavahkku|duorasdat|bearjadat|lávvardat',
  'sotnabeaivi|mánnodat|disdat|gaskavahkku|duorastat|bearjadat|lávvordat',
  'Dimingu|Chiposi|Chipiri|Chitatu|Chinai|Chishanu|Sabudu',
  'Alhadi|Atinni|Atalaata|Alarba|Alhamiisa|Alzuma|Asibti',
  'Bikua-ôko|Bïkua-ûse|Bïkua-ptâ|Bïkua-usïö|Bïkua-okü|Lâpôsö|Lâyenga',
  'ⴰⵙⴰⵎⴰⵙ|ⴰⵢⵏⴰⵙ|ⴰⵙⵉⵏⴰⵙ|ⴰⴽⵕⴰⵙ|ⴰⴽⵡⴰⵙ|ⵙⵉⵎⵡⴰⵙ|ⴰⵙⵉⴹⵢⴰⵙ',
  'ඉරිදා|සඳුදා|අඟහරුවාදා|බදාදා|බ්\u200dරහස්පතින්දා|සිකුරාදා|සෙනසුරාදා',
  'nedeľa|pondelok|utorok|streda|štvrtok|piatok|sobota',
  'nedelja|ponedeljek|torek|sreda|četrtek|petek|sobota',
  'pasepeeivi|vuossaargâ|majebaargâ|koskoho|tuorâstuv|vástuppeeivi|lávurduv',
  'Svondo|Muvhuro|Chipiri|Chitatu|China|Chishanu|Mugovera',
  'Axad|Isniin|Talaado|Arbaco|Khamiis|Jimco|Sabti',
  'e diel|e hënë|e martë|e mërkurë|e enjte|e premte|e shtunë',
  'недеља|понедељак|уторак|среда|четвртак|петак|субота',
  'недеља|понедељак|уторак|сриједа|четвртак|петак|субота',
  'Minggu|Senén|Salasa|Rebo|Kemis|Jumaah|Saptu',
  'ஞாயிறு|திங்கள்|செவ்வாய்|புதன்|வியாழன்|வெள்ளி|சனி',
  'ఆదివారం|సోమవారం|మంగళవారం|బుధవారం|గురువారం|శుక్రవారం|శనివారం',
  'Nakaejuma|Nakaebarasa|Nakaare|Nakauni|Nakaung’on|Nakakany|Nakasabiti',
  'Якшанбе|Душанбе|Сешанбе|Чоршанбе|Панҷшанбе|Ҷумъа|Шанбе',
  'วันอาทิตย์|วันจันทร์|วันอังคาร|วันพุธ|วันพฤหัสบดี|วันศุกร์|วันเสาร์',
  'ሰንበት|ሰኑይ|ሠሉስ|ረቡዕ|ኃሙስ|ዓርቢ|ቀዳም',
  'ýekşenbe|duşenbe|sişenbe|çarşenbe|penşenbe|anna|şenbe',
  'Sāpate|Mōnite|Tūsite|Pulelulu|Tuʻapulelulu|Falaite|Tokonaki',
  'Pazar|Pazartesi|Salı|Çarşamba|Perşembe|Cuma|Cumartesi',
  'якшәмбе|дүшәмбе|сишәмбе|чәршәмбе|пәнҗешәмбе|җомга|шимбә',
  'Asamas|Aynas|Asinas|Akras|Akwas|Asimwas|Asiḍyas',
  'يەكشەنبە|دۈشەنبە|سەيشەنبە|چارشەنبە|پەيشەنبە|جۈمە|شەنبە',
  'неділя|понеділок|вівторок|середа|четвер|пʼятниця|субота',
  'اتوار|پیر|منگل|بدھ|جمعرات|جمعہ|ہفتہ',
  'yakshanba|dushanba|seshanba|chorshanba|payshanba|juma|shanba',
  'ꕞꕌꔵ|ꗳꗡꘉ|ꕚꕞꕚ|ꕉꕞꕒ|ꕉꔤꕆꕢ|ꕉꔤꕀꕮ|ꔻꔬꔳ',
  'Chủ Nhật|Thứ Hai|Thứ Ba|Thứ Tư|Thứ Năm|Thứ Sáu|Thứ Bảy',
  'Sunntag|Mäntag|Zištag|Mittwuč|Fróntag|Fritag|Samštag',
  'Dibéer|Altine|Talaata|Àlarba|Alxamis|Àjjuma|Aseer',
  'Cawe|Mvulo|Lwesibini|Lwesithathu|Lwesine|Lwesihlanu|Mgqibelo',
  'Sabiiti|Balaza|Owokubili|Owokusatu|Olokuna|Olokutaanu|Olomukaaga',
  'sɔ́ndiɛ|móndie|muányáŋmóndie|metúkpíápɛ|kúpélimetúkpiapɛ|feléte|séselé',
  'זונטיק|מאָנטיק|דינסטיק|מיטוואך|דאנערשטיק|פֿרײַטיק|שבת',
  'Ọjọ́ Àìkú|Ọjọ́ Ajé|Ọjọ́ Ìsẹ́gun|Ọjọ́rú|Ọjọ́bọ|Ọjọ́ Ẹtì|Ọjọ́ Àbámẹ́ta',
  'Ɔjɔ́ Àìkú|Ɔjɔ́ Ajé|Ɔjɔ́ Ìsɛ́gun|Ɔjɔ́rú|Ɔjɔ́bɔ|Ɔjɔ́ Ɛtì|Ɔjɔ́ Àbámɛ́ta',
  'ⴰⵙⴰⵎⴰⵙ|ⴰⵢⵏⴰⵙ|ⴰⵙⵉⵏⴰⵙ|ⴰⴽⵕⴰⵙ|ⴰⴽⵡⴰⵙ|ⴰⵙⵉⵎⵡⴰⵙ|ⴰⵙⵉⴹⵢⴰⵙ',
  'ISonto|UMsombuluko|ULwesibili|ULwesithathu|ULwesine|ULwesihlanu|UMgqibelo',
];

/** getShortWeekdays(), '|'-separated. */
const SHORT_WEEKDAYS: readonly string[] = [
  'Sun|Mon|Tue|Wed|Thu|Fri|Sat',
  '周日|周一|周二|周三|周四|周五|周六',
  '週日|週一|週二|週三|週四|週五|週六',
  'zo|ma|di|wo|do|vr|za',
  'Sun.|Mon.|Tue.|Wed.|Thu.|Fri.|Sat.',
  'dim.|lun.|mar.|mer.|jeu.|ven.|sam.',
  'So.|Mo.|Di.|Mi.|Do.|Fr.|Sa.',
  'dom|lun|mar|mer|gio|ven|sab',
  '日|月|火|水|木|金|土',
  '일|월|화|수|목|금|토',
  'søn.|man.|tir.|ons.|tor.|fre.|lør.',
  'dom.|seg.|ter.|qua.|qui.|sex.|sáb.',
  'domingo|segunda|terça|quarta|quinta|sexta|sábado',
  'dom|lun|mar|mié|jue|vie|sáb',
  'sön|mån|tis|ons|tors|fre|lör',
  'So.|Ma.|Di.|Wo.|Do.|Vr.|Sa.',
  'nts|kpa|ghɔ|tɔm|ume|ghɨ|dzk',
  'Kwe|Dwo|Ben|Wuk|Yaw|Fia|Mem',
  'እሑድ|ሰኞ|ማክሰ|ረቡዕ|ሐሙስ|ዓርብ|ቅዳሜ',
  'الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت',
  'দেও|সোম|মঙ্গল|বুধ|বৃহ|শুক্ৰ|শনি',
  'Jpi|Jtt|Jnn|Jtn|Alh|Ijm|Jmo',
  'dom|llu|mar|mié|xue|vie|sáb',
  'B.|B.e.|Ç.a.|Ç.|C.a.|C.|Ş.',
  'nɔy|nja|uum|ŋge|mbɔ|kɔɔ|jon',
  'нд|пн|аў|ср|чц|пт|сб',
  'Pa Mulungu|Palichimo|Palichibuli|Palichitatu|Palichine|Palichisano|Pachibelushi',
  'Mul|Vil|Hiv|Hid|Hit|Hih|Lem',
  'нд|пн|вт|ср|чт|пт|сб',
  'kar|ntɛ|tar|ara|ala|jum|sib',
  'রবি|সোম|মঙ্গল|বুধ|বৃহস্পতি|শুক্র|শনি',
  'ཉི་མ་|ཟླ་བ་|མིག་དམར་|ལྷག་པ་|ཕུར་བུ་|པ་སངས་|སྤེན་པ་',
  'Sul|Lun|Meu.|Mer.|Yaou|Gwe.|Sad.',
  'रबि|सम|मंगल|बुद|बिसथि|सुखुर|सुनि',
  'ned|pon|uto|sri|čet|pet|sub',
  'dg.|dl.|dt.|dc.|dj.|dv.|ds.',
  '𑄢𑄧𑄝𑄨|𑄥𑄧𑄟𑄴|𑄟𑄧𑄁𑄉𑄧𑄣𑄴|𑄝𑄪𑄖𑄴|𑄝𑄳𑄢𑄨𑄥𑄪𑄛𑄴|𑄥𑄪𑄇𑄴𑄇𑄮𑄢𑄴|𑄥𑄧𑄚𑄨',
  'кӀи|ор|ши|кха|еа|пӀе|шуо',
  'Dom|Lun|Mar|Miy|Huw|Biy|Sab',
  'SAN|ORK|OKB|OKS|OKN|OKT|OMK',
  'ᏆᏍᎬ|ᏉᏅᎯ|ᏔᎵᏁ|ᏦᎢᏁ|ᏅᎩᏁ|ᏧᎾᎩ|ᏈᏕᎾ',
  'یەکشەممە|دووشەممە|سێشەممە|چوارشەممە|پێنجشەممە|ھەینی|شەممە',
  'ne|po|út|st|čt|pá|so',
  'Sul|Llun|Maw|Mer|Iau|Gwen|Sad',
  'Jum|Jim|Kaw|Kad|Kan|Kas|Ngu',
  'Alh|Ati|Ata|Ala|Alm|Alz|Asi',
  'ऐत|सोम|मंगल|बुध|बीर|शुक्र|शनि',
  'nje|pón|wał|srj|stw|pět|sob',
  'ét|mɔ́s|kwa|muk|ŋgi|ɗón|esa',
  'Dim|Ten|Tal|Ala|Ara|Arj|Sib',
  'ཟླ་|མིར་|ལྷག་|ཕུར་|སངས་|སྤེན་|ཉི་',
  'Kma|Tat|Ine|Tan|Arm|Maa|NMM',
  'kɔs|dzo|bla|kuɖ|yaw|fiɖ|mem',
  'Κυρ|Δευ|Τρί|Τετ|Πέμ|Παρ|Σάβ',
  'di|lu|ma|me|ĵa|ve|sa',
  'P|E|T|K|N|R|L',
  'ig.|al.|ar.|az.|og.|or.|lr.',
  'sɔ́n|mɔ́n|smb|sml|smn|fúl|sér',
  'یکشنبه|دوشنبه|سه\u200cشنبه|چهارشنبه|پنجشنبه|جمعه|شنبه',
  'dew|aaɓ|maw|nje|naa|mwd|hbi',
  'su|ma|ti|ke|to|pe|la',
  'Lin|Lun|Mar|Miy|Huw|Biy|Sab',
  'sun.|mán.|týs.|mik.|hós.|frí.|ley.',
  'dom|lun|mar|mie|joi|vin|sab',
  'si|mo|ti|wo|to|fr|so',
  'Domh|Luan|Máirt|Céad|Déar|Aoine|Sath',
  'DiD|DiL|DiM|DiC|Dia|Dih|DiS',
  'dom.|luns|mar.|mér.|xov.|ven.|sáb.',
  'Su.|Mä.|Zi.|Mi.|Du.|Fr.|Sa.',
  'રવિ|સોમ|મંગળ|બુધ|ગુરુ|શુક્ર|શનિ',
  'Cpr|Ctt|Cmn|Cmt|Ars|Icm|Est',
  'Jed|Jel|Jem|Jerc|Jerd|Jeh|Jes',
  'Lah|Lit|Tal|Lar|Alh|Jum|Asa',
  'LP|P1|P2|P3|P4|P5|P6',
  'יום א׳|יום ב׳|יום ג׳|יום ד׳|יום ה׳|יום ו׳|שבת',
  'रवि|सोम|मंगल|बुध|गुरु|शुक्र|शनि',
  'nje|pón|wut|srj|štw|pja|sob',
  'V|H|K|Sze|Cs|P|Szo',
  'կիր|երկ|երք|չրք|հնգ|ուր|շբթ',
  'dom|lun|mar|mer|jov|ven|sab',
  'Min|Sen|Sel|Rab|Kam|Jum|Sab',
  'Sọn|Mọn|Tiu|Wen|Tọọ|Fraị|Sat',
  'ꑭꆏ|ꆏꋍ|ꆏꑍ|ꆏꌕ|ꆏꇖ|ꆏꉬ|ꆏꃘ',
  'sun.|mán.|þri.|mið.|fim.|fös.|lau.',
  'Sɔ́ndi|Mɔ́ndi|Ápta Mɔ́ndi|Wɛ́nɛsɛdɛ|Tɔ́sɛdɛ|Fɛlâyɛdɛ|Sásidɛ',
  'Jpi|Jtt|Jnn|Jtn|Alh|Iju|Jmo',
  'Ahad|Sen|Sel|Rab|Kam|Jum|Sab',
  'კვი|ორშ|სამ|ოთხ|ხუთ|პარ|შაბ',
  'Yan|San|Kraḍ|Kuẓ|Sam|Sḍis|Say',
  'Wky|Wkw|Wkl|Wtũ|Wkn|Wtn|Wth',
  'Ll2|Ll3|Ll4|Ll5|Ll6|Ll7|Ll1',
  'dum|sig|ter|kua|kin|ses|sab',
  'Alh|Ati|Ata|Ala|Alm|Alj|Ass',
  'KMA|NTT|NMN|NMT|ART|NMA|NMM',
  'жс|дс|сс|ср|бс|жм|сб',
  'sɔndi|lundi|mardi|mɛrkɛrɛdi|yedi|vaŋdɛrɛdi|mɔnɔ sɔndi',
  'sap|ata|mar|pin|sis|tal|arf',
  'Kts|Kot|Koo|Kos|Koa|Kom|Kol',
  'អាទិត្យ|ចន្ទ|អង្គារ|ពុធ|ព្រហ|សុក្រ|សៅរ៍',
  'ಭಾನು|ಸೋಮ|ಮಂಗಳ|ಬುಧ|ಗುರು|ಶುಕ್ರ|ಶನಿ',
  'आयतार|सोमार|मंगळार|बुधवार|बिरेस्तार|शुक्रार|शेनवार',
  'آتھوار|ژٔندٕروار|بۆموار|بودوار|برؠسوار|جُمہ|بٹوار',
  'Jpi|Jtt|Jmn|Jtn|Alh|Iju|Jmo',
  'sɔ́n|lǝn|maa|mɛk|jǝǝ|júm|sam',
  'Su.|Mo.|Di.|Me.|Du.|Fr.|Sa.',
  'yş|dş|sş|çş|pş|în|ş',
  'Sul|Lun|Mth|Mhr|Yow|Gwe|Sad',
  'жек.|дүй.|шейш.|шарш.|бейш.|жума|ишм.',
  'Píili|Táatu|Íne|Táano|Alh|Ijm|Móosi',
  'Son.|Méi.|Dën.|Mët.|Don.|Fre.|Sam.',
  'Sab|Bal|Lw2|Lw3|Lw4|Lw5|Lw6',
  'Aŋpétuwakȟaŋ|Aŋpétuwaŋži|Aŋpétunuŋpa|Aŋpétuyamni|Aŋpétutopa|Aŋpétuzaptaŋ|Owáŋgyužažapi',
  'eye|ybo|mbl|mst|min|mtn|mps',
  'ອາທິດ|ຈັນ|ອັງຄານ|ພຸດ|ພະຫັດ|ສຸກ|ເສົາ',
  'sk|pr|an|tr|kt|pn|št',
  'Lum|Nko|Ndy|Ndg|Njw|Ngv|Lub',
  'JMP|WUT|TAR|TAD|TAN|TAB|NGS',
  'J2|J3|J4|J5|Al|Ij|J1',
  'svētd.|pirmd.|otrd.|trešd.|ceturtd.|piektd.|sestd.',
  'KIU|MRA|WAI|WET|WEN|WTN|JUM',
  'dim|lin|mar|mer|ze|van|sam',
  'Alah|Alats|Tal|Alar|Alak|Zom|Asab',
  'Sab|Jtt|Jnn|Jtn|Ara|Iju|Jmo',
  'Aneg 1|Aneg 2|Aneg 3|Aneg 4|Aneg 5|Aneg 6|Aneg 7',
  'Tap|Hin|Tū|Apa|Par|Mer|Hor',
  'нед.|пон.|вт.|сре.|чет.|пет.|саб.',
  'ഞായർ|തിങ്കൾ|ചൊവ്വ|ബുധൻ|വ്യാഴം|വെള്ളി|ശനി',
  'Ня|Да|Мя|Лх|Пү|Ба|Бя',
  'নোংমাইজিং|নিংথৌকাবা|লৈবাকপোকপা|য়ুমশকৈশা|শগোলশেন|ইরাই|থাংজ',
  'रवि|सोम|मंगळ|बुध|गुरु|शुक्र|शनि',
  'Ahd|Isn|Sel|Rab|Kha|Jum|Sab',
  'Ħad|Tne|Tli|Erb|Ħam|Ġim|Sib',
  'Cya|Cla|Czi|Cko|Cka|Cga|Cze',
  'တနင်္ဂနွေ|တနင်္လာ|အင်္ဂါ|ဗုဒ္ဓဟူး|ကြာသပတေး|သောကြာ|စနေ',
  'Son|Ma|De|Wu|Do|Fr|Sat',
  'Son|Mvu|Sib|Sit|Sin|Sih|Mgq',
  'आइत|सोम|मङ्गल|बुध|बिहि|शुक्र|शनि',
  'sɔ́n|mɔ́n|smb|sml|smn|mbs|sas',
  'sø.|må.|ty.|on.|to.|fr.|la.',
  'lyɛʼɛ́ sẅíŋtè|mvfò lyɛ̌ʼ|mbɔ́ɔntè mvfò lyɛ̌ʼ|tsètsɛ̀ɛ lyɛ̌ʼ|mbɔ́ɔntè tsetsɛ̀ɛ lyɛ̌ʼ|mvfò màga lyɛ̌ʼ|màga lyɛ̌ʼ',
  'Cäŋ|Jiec|Rɛw|Diɔ̱k|Ŋuaan|Dhieec|Bäkɛl',
  'Dil|Wix|Qib|Rob|Kam|Jim|San',
  'ରବି|ସୋମ|ମଙ୍ଗଳ|ବୁଧ|ଗୁରୁ|ଶୁକ୍ର|ଶନି',
  'хцб|крс|дцг|ӕрт|цпр|мрб|сбт',
  'ਐਤ|ਸੋਮ|ਮੰਗਲ|ਬੁੱਧ|ਵੀਰ|ਸ਼ੁੱਕਰ|ਸ਼ਨਿੱਚਰ',
  'Sọ́n|Mọ́n|Tiú|Wẹ́n|Tọ́z|Fraí|Sát',
  'niedz.|pon.|wt.|śr.|czw.|pt.|sob.',
  'يونۍ|دونۍ|درېنۍ|څلرنۍ|پينځنۍ|جمعه|اونۍ',
  'Dom|Lun|Mar|Mié|Jue|Vie|Sab',
  'du|gli|ma|me|gie|ve|so',
  'cu.|mbe.|kab.|gtu.|kan.|gnu.|gnd.',
  'dum.|lun.|mar.|mie.|joi|vin.|sâm.',
  'Dum|Lun|Mar|Mie|Joi|Vin|Sâm',
  'Ijp|Ijt|Ijn|Ijtn|Alh|Iju|Ijm',
  'вс|пн|вт|ср|чт|пт|сб',
  'cyu.|mbe.|kab.|gtu.|kan.|gnu.|gnd.',
  'бс|бн|оп|сэ|чп|бэ|сб',
  'Are|Kun|Ong|Ine|Ile|Sap|Kwe',
  'ᱥᱤᱸ|ᱚᱛ|ᱵᱟ|ᱥᱟᱹ|ᱥᱟᱹᱨ|ᱡᱟᱹ|ᱧᱩ',
  'Mul|Jtt|Jnn|Jtn|Alh|Iju|Jmo',
  'آچر|سومر|اڱارو|اربع|خميس|جمعو|ڇنڇر',
  'sotn|vuos|maŋ|gask|duor|bear|láv',
  'so|má|di|ga|du|be|lá',
  'Dim|Pos|Pir|Tat|Nai|Sha|Sab',
  'Bk1|Bk2|Bk3|Bk4|Bk5|Lâp|Lây',
  'ⴰⵙⴰ|ⴰⵢⵏ|ⴰⵙⵉ|ⴰⴽⵕ|ⴰⴽⵡ|ⴰⵙⵉⵎ|ⴰⵙⵉⴹ',
  'ඉරිදා|සඳුදා|අඟහ|බදාදා|බ්\u200dරහස්|සිකු|සෙන',
  'ne|po|ut|st|št|pi|so',
  'ned.|pon.|tor.|sre.|čet.|pet.|sob.',
  'pas|vuo|maj|kos|tuo|vás|láv',
  'Svo|Muv|Chp|Cht|Chn|Chs|Mug',
  'Axd|Isn|Tldo|Arbc|Khms|Jmc|Sbti',
  'Die|Hën|Mar|Mër|Enj|Pre|Sht',
  'нед|пон|уто|сре|чет|пет|суб',
  'нед|пон|уто|сри|чет|пет|суб',
  'Mng|Sen|Sal|Reb|Kem|Jum|Sap',
  'Jumapili|Jumatatu|Jumanne|Jumatano|Alhamisi|Ijumaa|Jumamosi',
  'ஞாயி.|திங்.|செவ்.|புத.|வியா.|வெள்.|சனி',
  'ఆది|సోమ|మంగళ|బుధ|గురు|శుక్ర|శని',
  'Jum|Bar|Aar|Uni|Ung|Kan|Sab',
  'Яшб|Дшб|Сшб|Чшб|Пшб|Ҷмъ|Шнб',
  'อา.|จ.|อ.|พ.|พฤ.|ศ.|ส.',
  'ሰን|ሰኑ|ሰሉ|ረቡ|ሓሙ|ዓር|ቀዳ',
  'ýek|duş|siş|çar|pen|ann|şen',
  'Sāp|Mōn|Tūs|Pul|Tuʻa|Fal|Tok',
  'Paz|Pzt|Sal|Çar|Per|Cum|Cmt',
  'якш.|дүш.|сиш.|чәр.|пәнҗ.|җом.|шим.',
  'Asa|Ayn|Asn|Akr|Akw|Asm|Asḍ',
  'يە|دۈ|سە|چا|پە|جۈ|شە',
  'اتوار|پیر|منگل|بدھ|جمعرات|جمعہ|ہفتہ',
  'Yak|Dush|Sesh|Chor|Pay|Jum|Shan',
  'ꕞꕌꔵ|ꗳꗡꘉ|ꕚꕞꕚ|ꕉꕞꕒ|ꕉꔤꕆꕢ|ꕉꔤꕀꕮ|ꔻꔬꔳ',
  'CN|Th 2|Th 3|Th 4|Th 5|Th 6|Th 7',
  'Sun|Män|Ziš|Mit|Fró|Fri|Sam',
  'Dib|Alt|Tal|Àla|Alx|Àjj|Ase',
  'Caw|Mvu|Bin|Tha|Sin|Hla|Mgq',
  'Sabi|Bala|Kubi|Kusa|Kuna|Kuta|Muka',
  'sd|md|mw|et|kl|fl|ss',
  'זונטיק|מאָנטיק|דינסטיק|מיטוואך|דאנערשטיק|פֿרײַטיק|שבת',
  'Àìk|Aj|Ìsẹ́g|Ọjọ́r|Ọjọ́b|Ẹt|Àbám',
  'Àìk|Aj|Ìsɛ́g|Ɔjɔ́r|Ɔjɔ́b|Ɛt|Àbám',
  '星期日|星期一|星期二|星期三|星期四|星期五|星期六',
  'Son|Mso|Bil|Tha|Sin|Hla|Mgq',
];

/** getDisplayName(ERA, SHORT_FORMAT), '|'-separated. */
const ERAS: readonly string[] = [
  'BC|AD',
  '公元前|公元',
  '西元前|西元',
  'v.Chr.|n.Chr.',
  'av. J.-C.|ap. J.-C.',
  'v. Chr.|n. Chr.',
  'a.C.|d.C.',
  '紀元前|西暦',
  'f.Kr.|e.Kr.',
  'a. C.|d. C.',
  'v.C.|n.C.',
  'SK|BK',
  'AK|KE',
  'ዓ/ዓ|ዓ/ም',
  'ق.م|م',
  'খ্ৰীঃ পূঃ|খ্ৰীঃ',
  'KM|BM',
  'e.C.|d.C.',
  'e.ə.|y.e.',
  'b.Y.K|m.Y.K',
  'да н.э.|н.э.',
  'пр.Хр.|сл.Хр.',
  'J.-C. ɲɛ|ni J.-C.',
  'খ্রিস্টপূর্ব|খৃষ্টাব্দ',
  'སྤྱི་ལོ་སྔོན་|སྤྱི་ལོ་',
  'a-raok J.K.|goude J.K.',
  'ईसा.पूर्व|सन',
  'p. n. e.|n. e.',
  'aC|dC',
  '𑄈𑄳𑄢𑄨𑄌𑄴𑄑𑄴𑄛𑄫𑄢𑄴𑄝𑄧|𑄈𑄳𑄢𑄨𑄌𑄴𑄑𑄛𑄴𑄘𑄧',
  'в. э. тӀ. я|в. э',
  'پێش زایین|زایینی',
  'př. n. l.|n. l.',
  'CC|OC',
  'KK|BK',
  'IJ|IZ',
  'ई.पू.|ईसवी',
  'pś.Chr.n.|pó Chr.n.',
  'ɓ.Ys|mb.Ys',
  'ArY|AtY',
  'BCE|CE',
  'MK|TK',
  'HYV|Yŋ',
  'π.Χ.|μ.Χ.',
  'aK|pK',
  'eKr|pKr',
  'K.a.|K.o.',
  'oyk|ayk',
  'ق.م.|م.',
  'H-I|C-I',
  'eKr.|jKr.',
  'pdC|ddC',
  'f.Kr.|n.Kr.',
  'RC|AD',
  'ઈ.સ.પૂર્વે|ઈ.સ.',
  'YA|YK',
  'K.H|BHAI',
  'לפנה״ס|לספירה',
  'ईसा-पूर्व|ईस्वी',
  'pr. Kr.|po. Kr.',
  'př.Chr.n.|po Chr.n.',
  'i. e.|i. sz.',
  'մ.թ.ա.|մ.թ.',
  'a.Chr.|p.Chr.',
  'SM|M',
  'T.K.|A.K.',
  'ꃅꋊꂿ|ꃅꋊꊂ',
  'ძვ. წ.|ახ. წ.',
  'snd. T.Ɛ|sld. T.Ɛ',
  'MY|IY',
  'AY|NY',
  'AK|DK',
  'б.з.д.|б.з.',
  'AM|KO',
  'មុន គ.ស.|គ.ស.',
  'ಕ್ರಿ.ಪೂ|ಕ್ರಿ.ಶ',
  'क्रिस्तपूर्व|क्रिस्तशखा',
  'بی سی|اے ڈی',
  'd.Y.|k.Y.',
  'BZ|PZ',
  'б.з.ч.|б.з.',
  'KSA|KA',
  'libóso ya|nsima ya Y',
  'ກ່ອນ ຄ.ສ.|ຄ.ສ.',
  'pr. Kr.|po Kr.',
  'kmp. Y.K.|kny. Y. K.',
  'p.m.ē.|m.ē.',
  'MY|EY',
  'MK|NK',
  'av. Z-K|ap. Z-K',
  'HY|YY',
  'п.н.е.|н.е.',
  'ക്രി.മു.|എഡി',
  'МЭӨ|МЭ',
  'খৃ: মমাং|খৃ: মতুং',
  'इ. स. पू.|इ. स.',
  'S.M.|TM',
  'QK|WK',
  'KK|PK',
  'ဘီစီ|အဒေီ',
  'پ.م|م.',
  'ईसा पूर्व|सन्',
  'BL|PB',
  'm.z.Y.|m.g.n.Y.',
  'AY|ƐY',
  'KD|CE',
  'н.д.а.|н.д.',
  'ਈ. ਪੂ.|ਸੰਨ',
  'BK|KIY',
  'p.n.e.|n.e.',
  'له میلاد وړاندې|م.',
  'BCE|d.C.',
  'av. Cr.|s. Cr.',
  'Mb.Y.|Ny.Y',
  'î.Hr.|d.Hr.',
  'до н. э.|н. э.',
  'б. э. и.|б. э',
  'ᱥᱮᱨᱢᱟ ᱞᱟᱦᱟ|ᱤᱥᱣᱤ',
  'AK|PK',
  'BC|CD',
  'o.Kr.|m.Kr.',
  'oKr.|mKr.',
  'AC|AD',
  'KnK|NpK',
  'ⴷⴰⵄ|ⴷⴼⵄ',
  'ක්\u200dරි.පූ.|ක්\u200dරි.ව.',
  'pred Kr.|po Kr.',
  'CH|CD',
  'p.K.|mb.K.',
  'п. н. е.|н. е.',
  'கி.மு.|கி.பி.',
  'క్రీపూ|క్రీశ',
  'ПеМ|ПаМ',
  'ก่อน ค.ศ.|ค.ศ.',
  'B.e.öň|B.e.',
  'KM|TS',
  'MÖ|MS',
  'б.э.к.|милади',
  'ZƐ|ḌƐ',
  'BCE|مىلادىيە',
  'до н. е.|н. е.',
  'قبل مسیح|عیسوی',
  'm.a.|milodiy',
  'Trước CN|Sau CN',
  'v. Chr.|n. Chr',
  'JC|AD',
  'AZ|AF',
  'k.Y.|+J.C.',
  'BCE|AD',
];

/** getEras(), '|'-separated. */
const LONG_ERAS: readonly string[] = [
  'BC|AD',
  '公元前|公元',
  '西元前|西元',
  'v.Chr.|n.Chr.',
  'av. J.-C.|ap. J.-C.',
  'v. Chr.|n. Chr.',
  'a.C.|d.C.',
  '紀元前|西暦',
  'f.Kr.|e.Kr.',
  'a. C.|d. C.',
  'v.C.|n.C.',
  'SK|BK',
  'AK|KE',
  'ዓ/ዓ|ዓ/ም',
  'ق.م|م',
  'খ্ৰীঃ পূঃ|খ্ৰীঃ',
  'KM|BM',
  'e.C.|d.C.',
  'e.ə.|y.e.',
  'b.Y.K|m.Y.K',
  'да н.э.|н.э.',
  'пр.Хр.|сл.Хр.',
  'J.-C. ɲɛ|ni J.-C.',
  'খ্রিস্টপূর্ব|খৃষ্টাব্দ',
  'སྤྱི་ལོ་སྔོན་|སྤྱི་ལོ་',
  'a-raok J.K.|goude J.K.',
  'ईसा.पूर्व|सन',
  'p. n. e.|n. e.',
  'aC|dC',
  '𑄈𑄳𑄢𑄨𑄌𑄴𑄑𑄴𑄛𑄫𑄢𑄴𑄝𑄧|𑄈𑄳𑄢𑄨𑄌𑄴𑄑𑄛𑄴𑄘𑄧',
  'в. э. тӀ. я|в. э',
  'پێش زایین|زایینی',
  'př. n. l.|n. l.',
  'CC|OC',
  'KK|BK',
  'IJ|IZ',
  'ई.पू.|ईसवी',
  'pś.Chr.n.|pó Chr.n.',
  'ɓ.Ys|mb.Ys',
  'ArY|AtY',
  'BCE|CE',
  'MK|TK',
  'HYV|Yŋ',
  'π.Χ.|μ.Χ.',
  'aK|pK',
  'eKr|pKr',
  'K.a.|K.o.',
  'oyk|ayk',
  'ق.م.|م.',
  'H-I|C-I',
  'eKr.|jKr.',
  'pdC|ddC',
  'f.Kr.|n.Kr.',
  'RC|AD',
  'ઈ.સ.પૂર્વે|ઈ.સ.',
  'YA|YK',
  'K.H|BHAI',
  'לפנה״ס|לספירה',
  'ईसा-पूर्व|ईस्वी',
  'pr. Kr.|po. Kr.',
  'př.Chr.n.|po Chr.n.',
  'i. e.|i. sz.',
  'մ.թ.ա.|մ.թ.',
  'a.Chr.|p.Chr.',
  'SM|M',
  'T.K.|A.K.',
  'ꃅꋊꂿ|ꃅꋊꊂ',
  'ძვ. წ.|ახ. წ.',
  'snd. T.Ɛ|sld. T.Ɛ',
  'MY|IY',
  'AY|NY',
  'AK|DK',
  'б.з.д.|б.з.',
  'AM|KO',
  'មុន គ.ស.|គ.ស.',
  'ಕ್ರಿ.ಪೂ|ಕ್ರಿ.ಶ',
  'क्रिस्तपूर्व|क्रिस्तशखा',
  'بی سی|اے ڈی',
  'd.Y.|k.Y.',
  'BZ|PZ',
  'б.з.ч.|б.з.',
  'KSA|KA',
  'libóso ya|nsima ya Y',
  'ກ່ອນ ຄ.ສ.|ຄ.ສ.',
  'pr. Kr.|po Kr.',
  'kmp. Y.K.|kny. Y. K.',
  'p.m.ē.|m.ē.',
  'MY|EY',
  'MK|NK',
  'av. Z-K|ap. Z-K',
  'HY|YY',
  'п.н.е.|н.е.',
  'ക്രി.മു.|എഡി',
  'МЭӨ|МЭ',
  'খৃ: মমাং|খৃ: মতুং',
  'इ. स. पू.|इ. स.',
  'S.M.|TM',
  'QK|WK',
  'KK|PK',
  'ဘီစီ|အဒေီ',
  'پ.م|م.',
  'ईसा पूर्व|सन्',
  'BL|PB',
  'm.z.Y.|m.g.n.Y.',
  'AY|ƐY',
  'KD|CE',
  'н.д.а.|н.д.',
  'ਈ. ਪੂ.|ਸੰਨ',
  'BK|KIY',
  'p.n.e.|n.e.',
  'له میلاد وړاندې|م.',
  'BCE|d.C.',
  'av. Cr.|s. Cr.',
  'Mb.Y.|Ny.Y',
  'î.Hr.|d.Hr.',
  'до н. э.|н. э.',
  'б. э. и.|б. э',
  'ᱥᱮᱨᱢᱟ ᱞᱟᱦᱟ|ᱤᱥᱣᱤ',
  'AK|PK',
  'BC|CD',
  'o.Kr.|m.Kr.',
  'oKr.|mKr.',
  'AC|AD',
  'KnK|NpK',
  'ⴷⴰⵄ|ⴷⴼⵄ',
  'ක්\u200dරි.පූ.|ක්\u200dරි.ව.',
  'pred Kr.|po Kr.',
  'CH|CD',
  'p.K.|mb.K.',
  'п. н. е.|н. е.',
  'п. н. е.|н. е',
  'கி.மு.|கி.பி.',
  'క్రీపూ|క్రీశ',
  'ПеМ|ПаМ',
  'ก่อน ค.ศ.|ค.ศ.',
  'ปีก่อนคริสต์กาลที่|ค.ศ.',
  'B.e.öň|B.e.',
  'KM|TS',
  'MÖ|MS',
  'б.э.к.|милади',
  'ZƐ|ḌƐ',
  'BCE|مىلادىيە',
  'до н. е.|н. е.',
  'قبل مسیح|عیسوی',
  'm.a.|milodiy',
  'Trước CN|Sau CN',
  'v. Chr.|n. Chr',
  'JC|AD',
  'AZ|AF',
  'k.Y.|+J.C.',
  'BCE|AD',
];

/** Indexes into MONTHS, SHORT_MONTHS, WEEKDAYS, SHORT_WEEKDAYS, ERAS and LONG_ERAS, and the names selecting them; en_US first. */
const LOCALES: ReadonlyArray<readonly [data: readonly number[], names: readonly string[]]> = [
  [
    [0, 0, 0, 0, 0, 0],
    [
      'en_US', 'English (New Zealand)', 'English (US)', 'agq_CM_#Latn', 'asa_TZ_#Latn', 'ast_ES_#Latn', 'az__#Cyrl',
      'az__#Latn', 'bas_CM_#Latn', 'bem_ZM_#Latn', 'bez_TZ_#Latn', 'brx_IN_#Deva', 'bs__#Cyrl', 'bs__#Latn',
      'ccp_BD_#Cakm', 'ceb_PH_#Latn', 'cgg_UG_#Latn', 'chr_US_#Cher', 'ckb_IQ_#Arab', 'dav_KE_#Latn', 'dje_NE_#Latn',
      'doi_IN_#Deva', 'dsb_DE_#Latn', 'dua_CM_#Latn', 'dyo_SN_#Latn', 'ebu_KE_#Latn', 'en', 'en_001', 'en_150', 'en_AE',
      'en_AG', 'en_AI', 'en_AS', 'en_AT', 'en_BB', 'en_BE', 'en_BI', 'en_BM', 'en_BS', 'en_BW', 'en_BZ', 'en_CC',
      'en_CH', 'en_CK', 'en_CM', 'en_CX', 'en_CY', 'en_DE', 'en_DG', 'en_DK', 'en_DM', 'en_ER', 'en_FI', 'en_FJ',
      'en_FK', 'en_FM', 'en_GD', 'en_GG', 'en_GH', 'en_GI', 'en_GM', 'en_GU', 'en_GY', 'en_HK', 'en_IE', 'en_IL',
      'en_IM', 'en_IN', 'en_IO', 'en_JE', 'en_JM', 'en_KE', 'en_KI', 'en_KN', 'en_KY', 'en_LC', 'en_LR', 'en_LS',
      'en_MG', 'en_MH', 'en_MO', 'en_MP', 'en_MS', 'en_MT', 'en_MU', 'en_MW', 'en_MY', 'en_NA', 'en_NF', 'en_NG',
      'en_NL', 'en_NR', 'en_NU', 'en_NZ', 'en_PG', 'en_PH', 'en_PK', 'en_PN', 'en_PR', 'en_PW', 'en_RW', 'en_SB',
      'en_SC', 'en_SD', 'en_SE', 'en_SG', 'en_SH', 'en_SI', 'en_SL', 'en_SS', 'en_SX', 'en_SZ', 'en_TC', 'en_TK',
      'en_TO', 'en_TT', 'en_TV', 'en_TZ', 'en_UG', 'en_UM', 'en_US_#Latn', 'en_US_POSIX', 'en_VC', 'en_VG', 'en_VI',
      'en_VU', 'en_WS', 'en_ZA', 'en_ZM', 'en_ZW', 'eo_001_#Latn', 'ewo_CM_#Latn', 'ff__#Adlm', 'ff__#Latn',
      'fil_PH_#Latn', 'fur_IT_#Latn', 'gsw_CH_#Latn', 'guz_KE_#Latn', 'haw_US_#Latn', 'hsb_DE_#Latn', 'ia_001_#Latn',
      'jgo_CM_#Latn', 'jmc_TZ_#Latn', 'kab_DZ_#Latn', 'kam_KE_#Latn', 'kde_TZ_#Latn', 'kea_CV_#Latn', 'khq_ML_#Latn',
      'kkj_CM_#Latn', 'kln_KE_#Latn', 'kok_IN_#Deva', 'ks__#Arab', 'ksb_TZ_#Latn', 'ksf_CM_#Latn', 'ksh_DE_#Latn',
      'lag_TZ_#Latn', 'lkt_US_#Latn', 'lrc_IR_#Arab', 'luo_KE_#Latn', 'luy_KE_#Latn', 'mai_IN_#Deva', 'mas_KE_#Latn',
      'mer_KE_#Latn', 'mfe_MU_#Latn', 'mgh_MZ_#Latn', 'mgo_CM_#Latn', 'mni_IN_#Beng', 'mni__#Beng', 'mua_CM_#Latn',
      'mzn_IR_#Arab', 'naq_NA_#Latn', 'nds_DE_#Latn', 'nmg_CM_#Latn', 'nnh_CM_#Latn', 'nus_SS_#Latn', 'nyn_UG_#Latn',
      'pa__#Arab', 'pa__#Guru', 'pcm_NG_#Latn', 'rof_TZ_#Latn', 'rwk_TZ_#Latn', 'sah_RU_#Cyrl', 'saq_KE_#Latn',
      'sat_IN_#Olck', 'sat__#Olck', 'sbp_TZ_#Latn', 'sd__#Arab', 'sd__#Deva', 'seh_MZ_#Latn', 'ses_ML_#Latn',
      'shi_MA_#Latn', 'shi_MA_#Tfng', 'shi__#Latn', 'shi__#Tfng', 'smn_FI_#Latn', 'sr__#Cyrl', 'sr__#Latn', 'su__#Latn',
      'teo_UG_#Latn', 'twq_NE_#Latn', 'tzm_MA_#Latn', 'uz__#Arab', 'uz__#Cyrl', 'uz__#Latn', 'vai_LR_#Latn',
      'vai_LR_#Vaii', 'vai__#Latn', 'vai__#Vaii', 'vun_TZ_#Latn', 'wae_CH_#Latn', 'xog_UG_#Latn', 'yav_CM_#Latn',
      'yi_001_#Hebr', 'yue_CN_#Hans', 'yue_HK_#Hant', 'yue__#Hans', 'yue__#Hant', 'zgh_MA_#Tfng', 'zh__#Hans',
      'zh__#Hant',
    ],
  ],
  [
    [1, 1, 1, 1, 1, 1],
    [
      'Chinese (China)', 'zh', 'zh_CN', 'zh_CN_#Hans',
    ],
  ],
  [
    [2, 1, 1, 2, 1, 1],
    [
      'Chinese (Hong Kong)', 'zh_HK', 'zh_HK_#Hans', 'zh_HK_#Hant', 'zh_MO', 'zh_MO_#Hans', 'zh_MO_#Hant',
    ],
  ],
  [
    [2, 1, 1, 2, 2, 2],
    [
      'Chinese (Taiwan)', 'zh_TW', 'zh_TW_#Hant',
    ],
  ],
  [
    [3, 2, 2, 3, 3, 3],
    [
      'Dutch (Belgian)', 'Dutch (Standard)', 'nl', 'nl_AW', 'nl_BE', 'nl_BQ', 'nl_CW', 'nl_NL', 'nl_NL_#Latn', 'nl_SR',
      'nl_SX',
    ],
  ],
  [
    [0, 3, 0, 0, 0, 0],
    [
      'English (Australian)', 'en_AU',
    ],
  ],
  [
    [0, 4, 0, 4, 0, 0],
    [
      'English (Canadian)', 'en_CA',
    ],
  ],
  [
    [0, 5, 0, 0, 0, 0],
    [
      'English (UK)', 'en_GB',
    ],
  ],
  [
    [4, 6, 3, 5, 4, 4],
    [
      'French (Belgian)', 'French (Standard)', 'French (Swiss)', 'fr', 'fr_BE', 'fr_BF', 'fr_BI', 'fr_BJ', 'fr_BL',
      'fr_CD', 'fr_CF', 'fr_CG', 'fr_CH', 'fr_CI', 'fr_CM', 'fr_DJ', 'fr_DZ', 'fr_FR', 'fr_FR_#Latn', 'fr_GA', 'fr_GF',
      'fr_GN', 'fr_GP', 'fr_GQ', 'fr_HT', 'fr_KM', 'fr_LU', 'fr_MC', 'fr_MF', 'fr_MG', 'fr_ML', 'fr_MQ', 'fr_MR',
      'fr_MU', 'fr_NC', 'fr_NE', 'fr_PF', 'fr_PM', 'fr_RE', 'fr_RW', 'fr_SC', 'fr_SN', 'fr_SY', 'fr_TD', 'fr_TG',
      'fr_TN', 'fr_VU', 'fr_WF', 'fr_YT',
    ],
  ],
  [
    [4, 7, 3, 5, 4, 4],
    [
      'French (Canadian)', 'fr_CA',
    ],
  ],
  [
    [5, 8, 4, 6, 5, 5],
    [
      'German (Austrian)', 'de_AT', 'de_IT',
    ],
  ],
  [
    [6, 9, 4, 6, 5, 5],
    [
      'German (Standard)', 'German (Swiss)', 'de', 'de_BE', 'de_CH', 'de_DE', 'de_DE_#Latn', 'de_LI', 'de_LU',
    ],
  ],
  [
    [7, 10, 5, 7, 6, 6],
    [
      'Italian (Standard)', 'Italian (Swiss)', 'it', 'it_CH', 'it_IT', 'it_IT_#Latn', 'it_SM', 'it_VA',
    ],
  ],
  [
    [2, 1, 6, 8, 7, 7],
    [
      'Japanese', 'ja', 'ja_JP', 'ja_JP_#Jpan',
    ],
  ],
  [
    [8, 11, 7, 9, 0, 0],
    [
      'Korean', 'ko', 'ko_KP', 'ko_KR', 'ko_KR_#Kore',
    ],
  ],
  [
    [9, 12, 8, 10, 8, 8],
    [
      'Norwegian (Bokmal)', 'Norwegian (Nynorsk)', 'nb', 'nb_NO', 'nb_NO_#Latn', 'nb_SJ', 'no', 'no_NO', 'no_NO_#Latn',
    ],
  ],
  [
    [10, 13, 9, 11, 6, 6],
    [
      'Portuguese (Brazilian)', 'pt', 'pt_BR', 'pt_BR_#Latn',
    ],
  ],
  [
    [10, 13, 9, 12, 6, 6],
    [
      'Portuguese (Standard)', 'pt_AO', 'pt_CH', 'pt_CV', 'pt_GQ', 'pt_GW', 'pt_LU', 'pt_MO', 'pt_MZ', 'pt_PT', 'pt_ST',
      'pt_TL',
    ],
  ],
  [
    [11, 14, 10, 13, 9, 9],
    [
      'Spanish (Mexican)', 'es_419', 'es_AR', 'es_BO', 'es_BR', 'es_BZ', 'es_CL', 'es_CO', 'es_CR', 'es_CU', 'es_DO',
      'es_EC', 'es_GT', 'es_HN', 'es_MX', 'es_NI', 'es_PA', 'es_PR', 'es_SV', 'es_US',
    ],
  ],
  [
    [11, 15, 10, 13, 9, 9],
    [
      'Spanish (Modern)', 'Spanish (Standard)', 'es', 'es_EA', 'es_ES', 'es_ES_#Latn', 'es_GQ', 'es_IC', 'es_PH',
    ],
  ],
  [
    [12, 16, 11, 14, 8, 8],
    [
      'Swedish', 'sv', 'sv_AX', 'sv_FI', 'sv_SE', 'sv_SE_#Latn',
    ],
  ],
  [
    [13, 17, 12, 15, 10, 10],
    [
      'af', 'af_NA', 'af_ZA', 'af_ZA_#Latn',
    ],
  ],
  [
    [14, 18, 13, 16, 11, 11],
    [
      'agq', 'agq_CM',
    ],
  ],
  [
    [15, 19, 14, 17, 12, 12],
    [
      'ak', 'ak_GH', 'ak_GH_#Latn',
    ],
  ],
  [
    [16, 20, 15, 18, 13, 13],
    [
      'am', 'am_ET', 'am_ET_#Ethi',
    ],
  ],
  [
    [17, 21, 16, 19, 14, 14],
    [
      'ar', 'ar_001', 'ar_AE', 'ar_BH', 'ar_DJ', 'ar_EG', 'ar_EG_#Arab', 'ar_EH', 'ar_ER', 'ar_IL', 'ar_KM', 'ar_KW',
      'ar_LY', 'ar_OM', 'ar_QA', 'ar_SA', 'ar_SD', 'ar_SO', 'ar_SS', 'ar_TD', 'ar_YE',
    ],
  ],
  [
    [18, 22, 16, 19, 14, 14],
    [
      'ar_DZ', 'ar_TN',
    ],
  ],
  [
    [19, 23, 16, 19, 14, 14],
    [
      'ar_IQ',
    ],
  ],
  [
    [19, 24, 16, 19, 14, 14],
    [
      'ar_JO', 'ar_LB', 'ar_PS', 'ar_SY',
    ],
  ],
  [
    [20, 25, 16, 19, 14, 14],
    [
      'ar_MA',
    ],
  ],
  [
    [21, 26, 16, 19, 14, 14],
    [
      'ar_MR',
    ],
  ],
  [
    [22, 27, 17, 20, 15, 15],
    [
      'as', 'as_IN', 'as_IN_#Beng',
    ],
  ],
  [
    [23, 28, 18, 21, 16, 16],
    [
      'asa', 'asa_TZ',
    ],
  ],
  [
    [24, 29, 19, 22, 17, 17],
    [
      'ast', 'ast_ES',
    ],
  ],
  [
    [25, 30, 20, 23, 18, 18],
    [
      'az', 'az_AZ', 'az_AZ_#Cyrl', 'az_AZ_#Latn',
    ],
  ],
  [
    [26, 31, 21, 24, 19, 19],
    [
      'bas', 'bas_CM',
    ],
  ],
  [
    [27, 32, 22, 25, 20, 20],
    [
      'be', 'be_BY', 'be_BY_#Cyrl',
    ],
  ],
  [
    [28, 33, 23, 26, 0, 0],
    [
      'bem', 'bem_ZM',
    ],
  ],
  [
    [29, 34, 24, 27, 16, 16],
    [
      'bez', 'bez_TZ',
    ],
  ],
  [
    [30, 35, 25, 28, 21, 21],
    [
      'bg', 'bg_BG', 'bg_BG_#Cyrl',
    ],
  ],
  [
    [31, 36, 26, 29, 22, 22],
    [
      'bm', 'bm_ML', 'bm_ML_#Latn',
    ],
  ],
  [
    [32, 37, 27, 30, 23, 23],
    [
      'bn', 'bn_BD', 'bn_BD_#Beng', 'bn_IN',
    ],
  ],
  [
    [33, 38, 28, 31, 24, 24],
    [
      'bo', 'bo_CN', 'bo_CN_#Tibt', 'bo_IN',
    ],
  ],
  [
    [34, 39, 29, 32, 25, 25],
    [
      'br', 'br_FR', 'br_FR_#Latn',
    ],
  ],
  [
    [35, 40, 30, 33, 26, 26],
    [
      'brx', 'brx_IN',
    ],
  ],
  [
    [36, 41, 31, 34, 27, 27],
    [
      'bs', 'bs_BA', 'bs_BA_#Cyrl', 'bs_BA_#Latn',
    ],
  ],
  [
    [37, 42, 32, 35, 28, 28],
    [
      'ca', 'ca_AD', 'ca_ES', 'ca_ES_#Latn', 'ca_ES_VALENCIA', 'ca_FR', 'ca_IT',
    ],
  ],
  [
    [38, 43, 33, 36, 29, 29],
    [
      'ccp', 'ccp_BD', 'ccp_IN',
    ],
  ],
  [
    [39, 44, 34, 37, 30, 30],
    [
      'ce', 'ce_RU', 'ce_RU_#Cyrl',
    ],
  ],
  [
    [40, 45, 35, 38, 0, 0],
    [
      'ceb', 'ceb_PH',
    ],
  ],
  [
    [41, 46, 36, 39, 0, 0],
    [
      'cgg', 'cgg_UG', 'nyn', 'nyn_UG',
    ],
  ],
  [
    [42, 47, 37, 40, 0, 0],
    [
      'chr', 'chr_US',
    ],
  ],
  [
    [43, 48, 38, 41, 31, 31],
    [
      'ckb', 'ckb_IQ', 'ckb_IR',
    ],
  ],
  [
    [44, 49, 39, 42, 32, 32],
    [
      'cs', 'cs_CZ', 'cs_CZ_#Latn',
    ],
  ],
  [
    [45, 50, 40, 43, 33, 33],
    [
      'cy', 'cy_GB', 'cy_GB_#Latn',
    ],
  ],
  [
    [46, 51, 8, 10, 8, 8],
    [
      'da', 'da_DK', 'da_DK_#Latn', 'da_GL',
    ],
  ],
  [
    [47, 52, 41, 44, 34, 34],
    [
      'dav', 'dav_KE',
    ],
  ],
  [
    [48, 53, 42, 45, 35, 35],
    [
      'dje', 'dje_NE',
    ],
  ],
  [
    [49, 54, 43, 46, 36, 36],
    [
      'doi', 'doi_IN',
    ],
  ],
  [
    [50, 55, 44, 47, 37, 37],
    [
      'dsb', 'dsb_DE',
    ],
  ],
  [
    [51, 56, 45, 48, 38, 38],
    [
      'dua', 'dua_CM',
    ],
  ],
  [
    [52, 57, 46, 49, 39, 39],
    [
      'dyo', 'dyo_SN',
    ],
  ],
  [
    [53, 58, 47, 50, 40, 40],
    [
      'dz', 'dz_BT', 'dz_BT_#Tibt',
    ],
  ],
  [
    [54, 59, 48, 51, 41, 41],
    [
      'ebu', 'ebu_KE',
    ],
  ],
  [
    [55, 60, 49, 52, 42, 42],
    [
      'ee', 'ee_GH', 'ee_GH_#Latn', 'ee_TG',
    ],
  ],
  [
    [56, 61, 50, 53, 43, 43],
    [
      'el', 'el_CY', 'el_GR', 'el_GR_#Grek',
    ],
  ],
  [
    [57, 62, 51, 54, 44, 44],
    [
      'eo', 'eo_001',
    ],
  ],
  [
    [58, 63, 10, 13, 9, 9],
    [
      'es_PE', 'es_UY',
    ],
  ],
  [
    [11, 64, 10, 13, 9, 9],
    [
      'es_PY', 'es_VE',
    ],
  ],
  [
    [59, 65, 52, 55, 45, 45],
    [
      'et', 'et_EE', 'et_EE_#Latn',
    ],
  ],
  [
    [60, 66, 53, 56, 46, 46],
    [
      'eu', 'eu_ES', 'eu_ES_#Latn',
    ],
  ],
  [
    [61, 67, 54, 57, 47, 47],
    [
      'ewo', 'ewo_CM',
    ],
  ],
  [
    [62, 68, 55, 58, 48, 48],
    [
      'fa', 'fa_IR', 'fa_IR_#Arab',
    ],
  ],
  [
    [63, 69, 55, 58, 48, 48],
    [
      'fa_AF',
    ],
  ],
  [
    [64, 70, 56, 59, 49, 49],
    [
      'ff', 'ff_BF_#Adlm', 'ff_BF_#Latn', 'ff_CM_#Adlm', 'ff_CM_#Latn', 'ff_GH_#Adlm', 'ff_GH_#Latn', 'ff_GM_#Adlm',
      'ff_GM_#Latn', 'ff_GN', 'ff_GN_#Adlm', 'ff_GN_#Latn', 'ff_GW_#Adlm', 'ff_GW_#Latn', 'ff_LR_#Adlm', 'ff_LR_#Latn',
      'ff_MR_#Adlm', 'ff_MR_#Latn', 'ff_NE_#Adlm', 'ff_NE_#Latn', 'ff_NG_#Adlm', 'ff_NG_#Latn', 'ff_SL_#Adlm',
      'ff_SL_#Latn', 'ff_SN', 'ff_SN_#Adlm', 'ff_SN_#Latn',
    ],
  ],
  [
    [65, 71, 57, 60, 50, 50],
    [
      'fi', 'fi_FI', 'fi_FI_#Latn',
    ],
  ],
  [
    [40, 45, 58, 61, 0, 0],
    [
      'fil', 'fil_PH',
    ],
  ],
  [
    [66, 12, 59, 62, 8, 8],
    [
      'fo', 'fo_DK', 'fo_FO', 'fo_FO_#Latn',
    ],
  ],
  [
    [4, 72, 3, 5, 4, 4],
    [
      'fr_MA',
    ],
  ],
  [
    [67, 73, 60, 63, 51, 51],
    [
      'fur', 'fur_IT',
    ],
  ],
  [
    [68, 74, 61, 64, 52, 52],
    [
      'fy', 'fy_NL', 'fy_NL_#Latn',
    ],
  ],
  [
    [69, 75, 62, 65, 53, 53],
    [
      'ga', 'ga_GB', 'ga_IE', 'ga_IE_#Latn',
    ],
  ],
  [
    [70, 76, 63, 66, 53, 53],
    [
      'gd', 'gd_GB', 'gd_GB_#Latn',
    ],
  ],
  [
    [71, 77, 64, 67, 6, 6],
    [
      'gl', 'gl_ES', 'gl_ES_#Latn',
    ],
  ],
  [
    [72, 78, 65, 68, 5, 5],
    [
      'gsw', 'gsw_CH', 'gsw_FR', 'gsw_LI',
    ],
  ],
  [
    [73, 79, 66, 69, 54, 54],
    [
      'gu', 'gu_IN', 'gu_IN_#Gujr',
    ],
  ],
  [
    [74, 80, 67, 70, 55, 55],
    [
      'guz', 'guz_KE',
    ],
  ],
  [
    [75, 81, 68, 71, 53, 53],
    [
      'gv', 'gv_IM', 'gv_IM_#Latn',
    ],
  ],
  [
    [76, 82, 69, 72, 56, 56],
    [
      'ha', 'ha_GH', 'ha_NE', 'ha_NG', 'ha_NG_#Latn',
    ],
  ],
  [
    [77, 83, 70, 73, 40, 40],
    [
      'haw', 'haw_US',
    ],
  ],
  [
    [78, 84, 71, 74, 57, 57],
    [
      'he', 'he_IL', 'he_IL_#Hebr',
    ],
  ],
  [
    [79, 85, 72, 75, 58, 58],
    [
      'hi', 'hi_IN', 'hi_IN_#Deva', 'mai', 'mai_IN',
    ],
  ],
  [
    [80, 86, 31, 34, 59, 59],
    [
      'hr', 'hr_BA', 'hr_HR', 'hr_HR_#Latn',
    ],
  ],
  [
    [81, 87, 73, 76, 60, 60],
    [
      'hsb', 'hsb_DE',
    ],
  ],
  [
    [82, 88, 74, 77, 61, 61],
    [
      'hu', 'hu_HU', 'hu_HU_#Latn',
    ],
  ],
  [
    [83, 89, 75, 78, 62, 62],
    [
      'hy', 'hy_AM', 'hy_AM_#Armn',
    ],
  ],
  [
    [84, 90, 76, 79, 63, 63],
    [
      'ia', 'ia_001',
    ],
  ],
  [
    [85, 91, 77, 80, 64, 64],
    [
      'id', 'id_ID', 'id_ID_#Latn',
    ],
  ],
  [
    [86, 92, 78, 81, 65, 65],
    [
      'ig', 'ig_NG', 'ig_NG_#Latn',
    ],
  ],
  [
    [87, 93, 79, 82, 66, 66],
    [
      'ii', 'ii_CN', 'ii_CN_#Yiii',
    ],
  ],
  [
    [88, 94, 80, 83, 8, 8],
    [
      'is', 'is_IS', 'is_IS_#Latn',
    ],
  ],
  [
    [2, 95, 6, 8, 7, 7],
    [
      'ja_JP_JP_#u-ca-japanese',
    ],
  ],
  [
    [89, 96, 81, 84, 40, 40],
    [
      'jgo', 'jgo_CM',
    ],
  ],
  [
    [90, 97, 82, 85, 34, 34],
    [
      'jmc', 'jmc_TZ', 'rwk', 'rwk_TZ', 'vun', 'vun_TZ',
    ],
  ],
  [
    [85, 98, 83, 86, 64, 64],
    [
      'jv', 'jv_ID', 'jv_ID_#Latn',
    ],
  ],
  [
    [91, 99, 84, 87, 67, 67],
    [
      'ka', 'ka_GE', 'ka_GE_#Geor',
    ],
  ],
  [
    [92, 100, 85, 88, 68, 68],
    [
      'kab', 'kab_DZ',
    ],
  ],
  [
    [93, 101, 86, 89, 69, 69],
    [
      'kam', 'kam_KE',
    ],
  ],
  [
    [94, 97, 87, 90, 70, 70],
    [
      'kde', 'kde_TZ',
    ],
  ],
  [
    [95, 102, 88, 91, 71, 71],
    [
      'kea', 'kea_CV',
    ],
  ],
  [
    [48, 53, 89, 92, 35, 35],
    [
      'khq', 'khq_ML',
    ],
  ],
  [
    [96, 103, 90, 93, 41, 41],
    [
      'ki', 'ki_KE', 'ki_KE_#Latn',
    ],
  ],
  [
    [97, 104, 91, 94, 72, 72],
    [
      'kk', 'kk_KZ', 'kk_KZ_#Cyrl',
    ],
  ],
  [
    [98, 105, 92, 95, 40, 40],
    [
      'kkj', 'kkj_CM',
    ],
  ],
  [
    [99, 106, 93, 96, 40, 40],
    [
      'kl', 'kl_GL', 'kl_GL_#Latn',
    ],
  ],
  [
    [100, 107, 94, 97, 73, 73],
    [
      'kln', 'kln_KE',
    ],
  ],
  [
    [101, 108, 95, 98, 74, 74],
    [
      'km', 'km_KH', 'km_KH_#Khmr',
    ],
  ],
  [
    [102, 109, 96, 99, 75, 75],
    [
      'kn', 'kn_IN', 'kn_IN_#Knda',
    ],
  ],
  [
    [103, 110, 97, 100, 76, 76],
    [
      'kok', 'kok_IN',
    ],
  ],
  [
    [104, 111, 98, 101, 77, 77],
    [
      'ks', 'ks_IN', 'ks_IN_#Arab',
    ],
  ],
  [
    [105, 97, 99, 102, 34, 34],
    [
      'ksb', 'ksb_TZ',
    ],
  ],
  [
    [106, 112, 100, 103, 78, 78],
    [
      'ksf', 'ksf_CM',
    ],
  ],
  [
    [107, 113, 101, 104, 5, 5],
    [
      'ksh', 'ksh_DE',
    ],
  ],
  [
    [108, 114, 102, 105, 79, 79],
    [
      'ku', 'ku_TR', 'ku_TR_#Latn',
    ],
  ],
  [
    [109, 115, 103, 106, 53, 53],
    [
      'kw', 'kw_GB', 'kw_GB_#Latn',
    ],
  ],
  [
    [39, 116, 104, 107, 80, 80],
    [
      'ky', 'ky_KG', 'ky_KG_#Cyrl',
    ],
  ],
  [
    [110, 117, 105, 108, 81, 81],
    [
      'lag', 'lag_TZ',
    ],
  ],
  [
    [111, 118, 106, 109, 5, 5],
    [
      'lb', 'lb_LU', 'lb_LU_#Latn',
    ],
  ],
  [
    [112, 119, 107, 110, 0, 0],
    [
      'lg', 'lg_UG', 'lg_UG_#Latn',
    ],
  ],
  [
    [113, 120, 108, 111, 40, 40],
    [
      'lkt', 'lkt_US',
    ],
  ],
  [
    [114, 121, 109, 112, 82, 82],
    [
      'ln', 'ln_AO', 'ln_CD', 'ln_CD_#Latn', 'ln_CF', 'ln_CG',
    ],
  ],
  [
    [115, 122, 110, 113, 83, 83],
    [
      'lo', 'lo_LA', 'lo_LA_#Laoo',
    ],
  ],
  [
    [116, 123, 111, 0, 40, 40],
    [
      'lrc', 'lrc_IQ', 'lrc_IR',
    ],
  ],
  [
    [117, 124, 112, 114, 84, 84],
    [
      'lt', 'lt_LT', 'lt_LT_#Latn',
    ],
  ],
  [
    [118, 125, 113, 115, 85, 85],
    [
      'lu', 'lu_CD', 'lu_CD_#Latn',
    ],
  ],
  [
    [119, 126, 114, 116, 0, 0],
    [
      'luo', 'luo_KE',
    ],
  ],
  [
    [23, 127, 115, 117, 0, 0],
    [
      'luy', 'luy_KE',
    ],
  ],
  [
    [120, 128, 116, 118, 86, 86],
    [
      'lv', 'lv_LV', 'lv_LV_#Latn',
    ],
  ],
  [
    [121, 129, 117, 85, 87, 87],
    [
      'mas', 'mas_KE', 'mas_TZ',
    ],
  ],
  [
    [122, 130, 118, 119, 88, 88],
    [
      'mer', 'mer_KE',
    ],
  ],
  [
    [123, 131, 119, 120, 89, 89],
    [
      'mfe', 'mfe_MU',
    ],
  ],
  [
    [124, 132, 120, 121, 0, 0],
    [
      'mg', 'mg_MG', 'mg_MG_#Latn',
    ],
  ],
  [
    [125, 133, 121, 122, 90, 90],
    [
      'mgh', 'mgh_MZ',
    ],
  ],
  [
    [126, 134, 122, 123, 40, 40],
    [
      'mgo', 'mgo_CM',
    ],
  ],
  [
    [127, 135, 123, 124, 40, 40],
    [
      'mi', 'mi_NZ', 'mi_NZ_#Latn',
    ],
  ],
  [
    [128, 136, 124, 125, 91, 91],
    [
      'mk', 'mk_MK', 'mk_MK_#Cyrl',
    ],
  ],
  [
    [129, 137, 125, 126, 92, 92],
    [
      'ml', 'ml_IN', 'ml_IN_#Mlym',
    ],
  ],
  [
    [130, 138, 126, 127, 93, 93],
    [
      'mn', 'mn_MN', 'mn_MN_#Cyrl',
    ],
  ],
  [
    [131, 139, 127, 128, 94, 94],
    [
      'mni', 'mni_IN',
    ],
  ],
  [
    [132, 140, 128, 129, 95, 95],
    [
      'mr', 'mr_IN', 'mr_IN_#Deva',
    ],
  ],
  [
    [133, 141, 129, 130, 96, 96],
    [
      'ms', 'ms_BN', 'ms_ID', 'ms_MY', 'ms_MY_#Latn', 'ms_SG',
    ],
  ],
  [
    [134, 142, 130, 131, 97, 97],
    [
      'mt', 'mt_MT', 'mt_MT_#Latn',
    ],
  ],
  [
    [135, 143, 131, 132, 98, 98],
    [
      'mua', 'mua_CM',
    ],
  ],
  [
    [136, 144, 132, 133, 99, 99],
    [
      'my', 'my_MM', 'my_MM_#Mymr',
    ],
  ],
  [
    [137, 145, 111, 0, 100, 100],
    [
      'mzn', 'mzn_IR',
    ],
  ],
  [
    [138, 0, 133, 134, 0, 0],
    [
      'naq', 'naq_NA',
    ],
  ],
  [
    [139, 146, 134, 135, 0, 0],
    [
      'nd', 'nd_ZW', 'nd_ZW_#Latn',
    ],
  ],
  [
    [140, 0, 111, 0, 40, 40],
    [
      'nds', 'nds_DE', 'nds_NL',
    ],
  ],
  [
    [141, 147, 135, 136, 101, 101],
    [
      'ne', 'ne_IN', 'ne_NP', 'ne_NP_#Deva',
    ],
  ],
  [
    [142, 148, 136, 137, 102, 102],
    [
      'nmg', 'nmg_CM',
    ],
  ],
  [
    [9, 149, 137, 138, 8, 8],
    [
      'nn', 'nn_NO', 'nn_NO_#Latn', 'no_NO_NY',
    ],
  ],
  [
    [143, 150, 138, 139, 103, 103],
    [
      'nnh', 'nnh_CM',
    ],
  ],
  [
    [144, 151, 139, 140, 104, 104],
    [
      'nus', 'nus_SS',
    ],
  ],
  [
    [145, 152, 140, 141, 40, 40],
    [
      'om', 'om_ET', 'om_ET_#Latn',
    ],
  ],
  [
    [145, 152, 140, 141, 105, 105],
    [
      'om_KE',
    ],
  ],
  [
    [146, 153, 141, 142, 0, 0],
    [
      'or', 'or_IN', 'or_IN_#Orya',
    ],
  ],
  [
    [147, 154, 142, 143, 106, 106],
    [
      'os', 'os_GE', 'os_GE_#Cyrl', 'os_RU',
    ],
  ],
  [
    [148, 155, 143, 144, 107, 107],
    [
      'pa', 'pa_IN', 'pa_IN_#Guru', 'pa_PK', 'pa_PK_#Arab',
    ],
  ],
  [
    [149, 156, 144, 145, 108, 108],
    [
      'pcm', 'pcm_NG',
    ],
  ],
  [
    [150, 157, 145, 146, 109, 109],
    [
      'pl', 'pl_PL', 'pl_PL_#Latn',
    ],
  ],
  [
    [151, 158, 146, 147, 110, 110],
    [
      'ps', 'ps_AF', 'ps_AF_#Arab', 'ps_PK',
    ],
  ],
  [
    [152, 159, 147, 148, 111, 111],
    [
      'qu', 'qu_BO', 'qu_EC', 'qu_PE', 'qu_PE_#Latn',
    ],
  ],
  [
    [153, 160, 148, 149, 112, 112],
    [
      'rm', 'rm_CH', 'rm_CH_#Latn',
    ],
  ],
  [
    [154, 161, 149, 150, 113, 113],
    [
      'rn', 'rn_BI', 'rn_BI_#Latn',
    ],
  ],
  [
    [155, 162, 150, 151, 114, 114],
    [
      'ro', 'ro_RO', 'ro_RO_#Latn',
    ],
  ],
  [
    [155, 162, 150, 152, 114, 114],
    [
      'ro_MD',
    ],
  ],
  [
    [156, 163, 151, 153, 16, 16],
    [
      'rof', 'rof_TZ',
    ],
  ],
  [
    [157, 164, 152, 154, 115, 115],
    [
      'ru', 'ru_BY', 'ru_KG', 'ru_KZ', 'ru_MD', 'ru_RU', 'ru_RU_#Cyrl', 'ru_UA',
    ],
  ],
  [
    [158, 165, 153, 155, 40, 40],
    [
      'rw', 'rw_RW', 'rw_RW_#Latn',
    ],
  ],
  [
    [159, 166, 154, 75, 40, 40],
    [
      'sa', 'sa_IN', 'sa_IN_#Deva',
    ],
  ],
  [
    [160, 167, 155, 156, 116, 116],
    [
      'sah', 'sah_RU',
    ],
  ],
  [
    [161, 168, 156, 157, 34, 34],
    [
      'saq', 'saq_KE',
    ],
  ],
  [
    [162, 169, 157, 158, 117, 117],
    [
      'sat', 'sat_IN',
    ],
  ],
  [
    [163, 170, 158, 159, 118, 118],
    [
      'sbp', 'sbp_TZ',
    ],
  ],
  [
    [164, 171, 159, 160, 119, 119],
    [
      'sd', 'sd_IN', 'sd_IN_#Deva', 'sd_PK', 'sd_PK_#Arab',
    ],
  ],
  [
    [165, 172, 160, 161, 120, 120],
    [
      'se', 'se_NO', 'se_NO_#Latn', 'se_SE',
    ],
  ],
  [
    [165, 173, 161, 162, 121, 121],
    [
      'se_FI',
    ],
  ],
  [
    [166, 174, 162, 163, 122, 122],
    [
      'seh', 'seh_MZ',
    ],
  ],
  [
    [48, 53, 163, 45, 35, 35],
    [
      'ses', 'ses_ML', 'twq', 'twq_NE',
    ],
  ],
  [
    [167, 175, 164, 164, 123, 123],
    [
      'sg', 'sg_CF', 'sg_CF_#Latn',
    ],
  ],
  [
    [168, 176, 165, 165, 124, 124],
    [
      'shi', 'shi_MA',
    ],
  ],
  [
    [169, 177, 166, 166, 125, 125],
    [
      'si', 'si_LK', 'si_LK_#Sinh',
    ],
  ],
  [
    [170, 178, 167, 167, 126, 126],
    [
      'sk', 'sk_SK', 'sk_SK_#Latn',
    ],
  ],
  [
    [171, 179, 168, 168, 84, 84],
    [
      'sl', 'sl_SI', 'sl_SI_#Latn',
    ],
  ],
  [
    [172, 180, 169, 169, 121, 121],
    [
      'smn', 'smn_FI',
    ],
  ],
  [
    [173, 181, 170, 170, 0, 0],
    [
      'sn', 'sn_ZW', 'sn_ZW_#Latn',
    ],
  ],
  [
    [174, 182, 171, 171, 127, 127],
    [
      'so', 'so_DJ', 'so_ET', 'so_KE', 'so_SO', 'so_SO_#Latn',
    ],
  ],
  [
    [175, 183, 172, 172, 128, 128],
    [
      'sq', 'sq_AL', 'sq_AL_#Latn', 'sq_MK', 'sq_XK',
    ],
  ],
  [
    [176, 184, 173, 173, 129, 129],
    [
      'sr', 'sr_ME', 'sr_ME_#Cyrl', 'sr_ME_#Latn', 'sr_RS', 'sr_RS_#Cyrl', 'sr_RS_#Latn', 'sr_XK_#Cyrl', 'sr_XK_#Latn',
    ],
  ],
  [
    [177, 184, 174, 174, 129, 130],
    [
      'sr_BA', 'sr_BA_#Cyrl', 'sr_BA_#Latn',
    ],
  ],
  [
    [176, 184, 173, 173, 129, 130],
    [
      'sr_CS',
    ],
  ],
  [
    [178, 185, 175, 175, 64, 64],
    [
      'su', 'su_ID', 'su_ID_#Latn',
    ],
  ],
  [
    [23, 97, 18, 176, 34, 34],
    [
      'sw', 'sw_CD', 'sw_KE', 'sw_TZ', 'sw_TZ_#Latn', 'sw_UG',
    ],
  ],
  [
    [179, 186, 176, 177, 130, 131],
    [
      'ta', 'ta_IN', 'ta_IN_#Taml', 'ta_LK', 'ta_MY', 'ta_SG',
    ],
  ],
  [
    [180, 187, 177, 178, 131, 132],
    [
      'te', 'te_IN', 'te_IN_#Telu',
    ],
  ],
  [
    [181, 188, 178, 179, 34, 34],
    [
      'teo', 'teo_KE', 'teo_UG',
    ],
  ],
  [
    [182, 189, 179, 180, 132, 133],
    [
      'tg', 'tg_TJ', 'tg_TJ_#Cyrl',
    ],
  ],
  [
    [183, 190, 180, 181, 133, 134],
    [
      'th', 'th_TH', 'th_TH_#Thai',
    ],
  ],
  [
    [183, 190, 180, 181, 133, 135],
    [
      'th_TH_TH_#u-nu-thai',
    ],
  ],
  [
    [184, 191, 181, 182, 13, 13],
    [
      'ti', 'ti_ER', 'ti_ET', 'ti_ET_#Ethi',
    ],
  ],
  [
    [185, 192, 182, 183, 134, 136],
    [
      'tk', 'tk_TM', 'tk_TM_#Latn',
    ],
  ],
  [
    [186, 193, 183, 184, 135, 137],
    [
      'to', 'to_TO', 'to_TO_#Latn',
    ],
  ],
  [
    [187, 194, 184, 185, 136, 138],
    [
      'tr', 'tr_CY', 'tr_TR', 'tr_TR_#Latn',
    ],
  ],
  [
    [188, 195, 185, 186, 137, 139],
    [
      'tt', 'tt_RU', 'tt_RU_#Cyrl',
    ],
  ],
  [
    [189, 196, 186, 187, 138, 140],
    [
      'tzm', 'tzm_MA',
    ],
  ],
  [
    [190, 197, 187, 188, 139, 141],
    [
      'ug', 'ug_CN', 'ug_CN_#Arab',
    ],
  ],
  [
    [191, 198, 188, 28, 140, 142],
    [
      'uk', 'uk_UA', 'uk_UA_#Cyrl',
    ],
  ],
  [
    [192, 199, 189, 189, 141, 143],
    [
      'ur', 'ur_IN', 'ur_PK', 'ur_PK_#Arab',
    ],
  ],
  [
    [193, 200, 190, 190, 142, 144],
    [
      'uz', 'uz_AF', 'uz_AF_#Arab', 'uz_UZ', 'uz_UZ_#Cyrl', 'uz_UZ_#Latn',
    ],
  ],
  [
    [194, 201, 191, 191, 40, 40],
    [
      'vai', 'vai_LR',
    ],
  ],
  [
    [195, 202, 192, 192, 143, 145],
    [
      'vi', 'vi_VN', 'vi_VN_#Latn',
    ],
  ],
  [
    [196, 203, 193, 193, 144, 146],
    [
      'wae', 'wae_CH',
    ],
  ],
  [
    [197, 204, 194, 194, 145, 147],
    [
      'wo', 'wo_SN', 'wo_SN_#Latn',
    ],
  ],
  [
    [198, 205, 195, 195, 0, 0],
    [
      'xh', 'xh_ZA', 'xh_ZA_#Latn',
    ],
  ],
  [
    [112, 119, 196, 196, 146, 148],
    [
      'xog', 'xog_UG',
    ],
  ],
  [
    [199, 206, 197, 197, 147, 149],
    [
      'yav', 'yav_CM',
    ],
  ],
  [
    [200, 207, 198, 198, 40, 40],
    [
      'yi', 'yi_001',
    ],
  ],
  [
    [201, 208, 199, 199, 148, 150],
    [
      'yo', 'yo_NG', 'yo_NG_#Latn',
    ],
  ],
  [
    [202, 209, 200, 200, 148, 150],
    [
      'yo_BJ',
    ],
  ],
  [
    [2, 1, 1, 201, 2, 2],
    [
      'yue', 'yue_CN', 'yue_HK',
    ],
  ],
  [
    [168, 176, 201, 165, 124, 124],
    [
      'zgh', 'zgh_MA',
    ],
  ],
  [
    [1, 210, 1, 1, 1, 1],
    [
      'zh_SG', 'zh_SG_#Hans',
    ],
  ],
  [
    [203, 211, 202, 202, 0, 0],
    [
      'zu', 'zu_ZA', 'zu_ZA_#Latn',
    ],
  ],
];

const BY_NAME: ReadonlyMap<string, number> = new Map(
  LOCALES.flatMap(([, names], index) => names.map((name) => [name.toLowerCase(), index] as const)),
);
const decoded = new Map<number, AcfDateNames>();

function entry(table: readonly string[], index: number | undefined): string[] {
  const value = index === undefined ? undefined : table[index];
  if (value === undefined) throw new RangeError(`Missing date name data at ${index}`);
  return value.split('|');
}

/** The names of the locale setLocale(`name`) selects (in any case), shared by equal sets; undefined for a name it refuses. */
export function acfDateNames(name: string): AcfDateNames | undefined {
  const index = BY_NAME.get(name.toLowerCase());
  if (index === undefined) return undefined;
  let names = decoded.get(index);
  if (names === undefined) {
    const [months, shortMonths, weekdays, shortWeekdays, eras, longEras] = LOCALES[index]?.[0] ?? [];
    names = {
      months: entry(MONTHS, months),
      shortMonths: entry(SHORT_MONTHS, shortMonths),
      weekdays: entry(WEEKDAYS, weekdays),
      shortWeekdays: entry(SHORT_WEEKDAYS, shortWeekdays),
      eras: entry(ERAS, eras),
      longEras: entry(LONG_ERAS, longEras),
    };
    decoded.set(index, names);
  }
  return names;
}
