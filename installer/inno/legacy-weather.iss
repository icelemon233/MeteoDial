// Guanxiang 0.1 stored an owned Chinese shortcut directly in Programs.
function LegacyWeatherLink(Desktop, AllUsers: Boolean): String;
begin
#ifdef QaRoot
  if Desktop then Result := '{#QaRoot}\shortcuts\desktop\观象.lnk'
  else Result := '{#QaRoot}\shortcuts\start\观象.lnk';
#else
  if Desktop then begin
    if AllUsers then Result := ExpandConstant('{commondesktop}\观象.lnk')
    else Result := ExpandConstant('{userdesktop}\观象.lnk');
  end else begin
    if AllUsers then Result := ExpandConstant('{commonprograms}\观象.lnk')
    else Result := ExpandConstant('{userprograms}\观象.lnk');
  end;
#endif
end;

function WasGuanxiangInstall: Boolean;
var DisplayName: String;
begin
  Result := RegQueryStringValue(SelectedRoot, InnoKey, 'DisplayName', DisplayName) and
    (CompareText(DisplayName, 'Guanxiang') = 0);
end;

function PreviousWeatherLink(Desktop, AllUsers: Boolean): String;
begin
#ifdef QaRoot
  if Desktop then Result := '{#QaRoot}\shortcuts\desktop\Guanxiang.lnk'
  else Result := '{#QaRoot}\shortcuts\start\Guanxiang\Guanxiang.lnk';
#else
  if Desktop then begin
    if AllUsers then Result := ExpandConstant('{commondesktop}\Guanxiang.lnk')
    else Result := ExpandConstant('{userdesktop}\Guanxiang.lnk');
  end else begin
    if AllUsers then Result := ExpandConstant('{commonprograms}\Guanxiang\Guanxiang.lnk')
    else Result := ExpandConstant('{userprograms}\Guanxiang\Guanxiang.lnk');
  end;
#endif
end;

procedure RememberPreviousWeatherInstall;
begin
  PreviousWeatherDirectory := '';
  PreviousWeatherUninstaller := '';
  if WasGuanxiangInstall then begin
    PreviousWeatherDirectory := RegisteredDirectory(InnoKey);
    PreviousWeatherUninstaller := RegisteredUninstaller(InnoKey);
  end;
end;

procedure RetirePreviousWeatherLinks;
var ProgramPath, Group: String;
begin
  if PreviousWeatherDirectory = '' then exit;
  if not SamePath(PreviousWeatherDirectory, ExpandConstant('{app}')) then exit;
  ProgramPath := AddBackslash(PreviousWeatherDirectory) + '{#Executable}';
  Group := ExtractFileDir(PreviousWeatherLink(False, IsAdminInstallMode));
  RemoveOwnedShortcut(PreviousWeatherLink(True, IsAdminInstallMode), ProgramPath);
  RemoveOwnedShortcut(PreviousWeatherLink(False, IsAdminInstallMode), ProgramPath);
  if PreviousWeatherUninstaller <> '' then
    RemoveOwnedShortcut(AddBackslash(Group) + '卸载 Guanxiang.lnk', PreviousWeatherUninstaller);
  RemoveDir(Group);
end;

procedure PreserveLegacyTaskDefaults;
var I: Integer; Value: Cardinal; Desktop, StartMenu: Boolean;
    Parameter, Directory, AppPath, TaskList: String;
begin
  if not WizardSilent then exit;
  Directory := PreviousWeatherDirectory;
  if Directory = '' then begin
    if RegisteredDirectory(InnoKey) <> '' then exit;
    Directory := RegisteredDirectory(LegacyKey);
  end;
  if Directory = '' then exit;
  for I := 1 to ParamCount do begin
    Parameter := Uppercase(ParamStr(I));
    if (Parameter = '/NOICONS') or (Pos('/TASKS=', Parameter) = 1) or
       (Pos('/MERGETASKS=', Parameter) = 1) or (Pos('/LOADINF=', Parameter) = 1) then exit;
  end;
  AppPath := AddBackslash(Directory) + '{#Executable}';
  if PreviousWeatherDirectory <> '' then begin
    Desktop := OwnsShortcut(PreviousWeatherLink(True, IsAdminInstallMode), AppPath);
    StartMenu := OwnsShortcut(PreviousWeatherLink(False, IsAdminInstallMode), AppPath);
    if RegQueryDWordValue(SelectedRoot, InnoKey, 'CinnaDesktopShortcut', Value) then Desktop := Value <> 0;
    if RegQueryDWordValue(SelectedRoot, InnoKey, 'CinnaStartMenuShortcut', Value) then StartMenu := Value <> 0;
  end else begin
    Desktop := OwnsShortcut(LegacyWeatherLink(True, IsAdminInstallMode), AppPath);
    StartMenu := OwnsShortcut(LegacyWeatherLink(False, IsAdminInstallMode), AppPath);
  end;
  if Desktop then TaskList := 'desktopicon' else TaskList := '!desktopicon';
  if StartMenu then TaskList := TaskList + ',startmenuicon' else TaskList := TaskList + ',!startmenuicon';
  WizardSelectTasks(TaskList);
end;

